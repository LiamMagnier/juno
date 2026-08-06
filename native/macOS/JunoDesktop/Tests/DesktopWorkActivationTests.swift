import Foundation
import JunoCore
import JunoWorkCore
import JunoWorkKit
import Observation
import Testing

@testable import JunoDesktop

/// Turning Juno Work on, and what has to happen for that to mean anything.
///
/// The defect these are written against is not a crash. Somebody opened Juno
/// Work on their Mac, read "Juno Work is switched off on this Mac." and stopped,
/// because nothing on that surface could switch it on — and had they found the
/// switch in ⌘,, they would have met a second dead end, since a Mac with the
/// master switch on and nothing granted advertises no capabilities and is still
/// passed over by the relay. Nothing anywhere had ever driven the switch from
/// off to on against a live account, so the wiring behind it had never run.
///
/// Three properties are worth pinning, and they are the three that were broken:
/// every state names itself and its own next step, taking that step actually
/// changes the state, and a claim loop that died is replaced rather than left
/// standing as evidence of a Mac that is serving.
@MainActor
struct DesktopWorkActivationTests {
    // MARK: - Each reason, from its inputs

    /// The five states, in the order their fixes have to happen in. A Mac that
    /// is off is not also "not paired": naming only the first blocker is what
    /// makes it safe for a surface to offer exactly one control.
    @Test func everyBlockerIsNamedByItsOwnInputs() async {
        let world = await World.make()

        // Off is the state a Mac starts in, and it survives being signed in.
        // Signing into Juno is not consent to hand a phone the filesystem.
        #expect(world.host.blocker == .switchedOff)

        world.host.allowWorkOnThisMac = true
        #expect(world.host.blocker == .signedOut)

        world.host.start(for: world.accountID)
        // Registration is in flight; this Mac has no host row id yet.
        #expect(world.host.blocker == .pairing)

        await world.settle { world.host.pairedHostID != nil }
        // Paired, on, and advertising nothing: the second dead end, which the
        // sentence about a switch would have sent nobody to fix.
        #expect(world.host.blocker == .nothingAllowed)
        #expect(!world.host.willServeDispatchedWork)

        world.host.allowsFileWork = true
        await world.settle { world.host.blocker == nil }
        #expect(world.host.willServeDispatchedWork)
    }

    /// Every sentence a surface can print has to survive the trip through the
    /// case, because the phone prints the same words for the same state.
    @Test func everySentenceIsTheOneTheSurfacesPrint() {
        #expect(DesktopWorkBlocker.switchedOff.sentence == "Juno Work is switched off on this Mac.")
        #expect(DesktopWorkBlocker.signedOut.sentence == "Sign in to let Juno Work use this Mac.")
        #expect(
            DesktopWorkBlocker.pairing.sentence
                == "This Mac has not finished pairing with your account yet."
        )
        #expect(DesktopWorkBlocker.starting.sentence == "Juno Work is starting on this Mac.")
        #expect(
            DesktopWorkBlocker.nothingAllowed.sentence
                == "Juno Work is on, but nothing has been allowed yet — grant a folder or turn on a capability."
        )
    }

    /// Only the two states somebody at this Mac can do something about carry a
    /// control. A button under "Juno Work is starting on this Mac." would be a
    /// button that does nothing to a state that clears itself.
    @Test func onlyTheAnswerableStatesOfferAControl() {
        #expect(DesktopWorkBlocker.switchedOff.actionTitle == "Turn On Juno Work")
        #expect(DesktopWorkBlocker.nothingAllowed.actionTitle == "Share a Folder…")
        #expect(DesktopWorkBlocker.signedOut.actionTitle == nil)
        #expect(DesktopWorkBlocker.pairing.actionTitle == nil)
        #expect(DesktopWorkBlocker.starting.actionTitle == nil)

        // Every case that offers a control also explains what it hands over.
        for blocker in DesktopWorkBlocker.allCases {
            #expect((blocker.actionTitle == nil) == (blocker.actionDetail == nil))
        }
    }

    // MARK: - Taking the step

    @Test func turningItOnFromTheMessageSwitchesItOn() {
        let host = Self.isolatedModel()
        #expect(host.blocker == .switchedOff)
        #expect(host.canTake(.switchedOff))

        #expect(host.take(.switchedOff))

        #expect(host.allowWorkOnThisMac)
        #expect(host.blocker != .switchedOff)
    }

    /// The folder chooser is the consent, so a closed panel must leave this Mac
    /// exactly as it was. Switching file work on regardless would be a
    /// capability granted by somebody pressing Cancel.
    @Test func refusingTheFolderPanelGrantsNothing() {
        let host = Self.isolatedModel()
        host.allowWorkOnThisMac = true
        host.grantActions = DesktopWorkGrantActions(
            addFolder: { _ in nil },
            setMode: { _, _ in },
            revoke: { _ in }
        )

        #expect(!host.take(.nothingAllowed))
        #expect(!host.allowsFileWork)
        #expect(host.policy.advertisedCapabilities.isEmpty)
    }

    /// And a folder that does come back turns file work on, because the
    /// advertisement reads the switch and not the grant list — without this the
    /// panel closes on a shared folder and the Mac still offers nothing.
    @Test func sharingAFolderAlsoAllowsFileWork() {
        let host = Self.isolatedModel()
        host.allowWorkOnThisMac = true
        let requested = Requested()
        host.grantActions = DesktopWorkGrantActions(
            addFolder: { mode in
                requested.mode = mode
                return "Reports"
            },
            setMode: { _, _ in },
            revoke: { _ in }
        )

        #expect(host.take(.nothingAllowed))

        #expect(host.allowsFileWork)
        #expect(host.policy.advertisedCapabilities == ["local_files"])
        // Read-only, and widened only in Settings: the narrowest useful grant is
        // the one to offer in a flow somebody is being walked through.
        #expect(requested.mode == .read)
    }

    /// A model with no grant store — the DEBUG preview harness composes one —
    /// must not offer a chooser it cannot open.
    @Test func withoutAGrantStoreTheFolderStepOffersNothing() {
        let host = Self.isolatedModel()
        host.allowWorkOnThisMac = true
        #expect(!host.canTake(.nothingAllowed))
        #expect(!host.take(.nothingAllowed))
    }

    // MARK: - The surfaces have to hear about it

    /// The switches are computed properties over `UserDefaults`, which
    /// `@Observable` cannot instrument on its own. Without the revision counter
    /// behind them, flipping one redraws nothing: the settings card papered over
    /// that with a counter of its own, and the Work window — which had none —
    /// went on printing "Juno Work is switched off on this Mac." after somebody
    /// had switched it on.
    @Test func flippingASwitchNotifiesTheSurfacesReadingIt() {
        let host = Self.isolatedModel()
        let notified = Flag()
        withObservationTracking {
            _ = host.unavailabilityReason
        } onChange: {
            notified.raise()
        }

        host.allowWorkOnThisMac = true

        #expect(notified.isRaised)
    }

    @Test func theAdvertisedPolicyIsObservedToo() {
        let host = Self.isolatedModel()
        host.allowWorkOnThisMac = true
        let notified = Flag()
        withObservationTracking {
            _ = host.policy.advertisedCapabilities
        } onChange: {
            notified.raise()
        }

        host.allowsFileWork = true

        #expect(notified.isRaised)
    }

    // MARK: - Ending in a Mac that actually serves

    /// The whole sequence, without a relaunch: switch on, grant something, and
    /// this Mac registers, claims and reports that it would take a task.
    @Test func switchingOnAndGrantingProducesAServingHost() async {
        let world = await World.make()
        world.host.start(for: world.accountID)
        await world.settle { world.host.pairedHostID != nil }

        // Off, but present. Registering while switched off is the split that
        // lets this Mac say "switched off" rather than "not paired".
        #expect(await world.relay.claimCount == 0)
        #expect(await world.registrar.lastPolicy?.enabled == false)

        world.host.take(.switchedOff)
        world.host.take(.nothingAllowed)

        await world.settle { world.host.willServeDispatchedWork }
        #expect(world.host.blocker == nil)
        // Settled rather than asserted outright: `willServeDispatchedWork` reads
        // the switches and the host's existence, while `phase` is written by the
        // activation that follows it. They converge, and a test that demanded
        // they were already equal would be asserting a scheduling order.
        await world.settle { world.host.phase == .serving }
        // The relay was told, and told the truth.
        await world.settle { await world.relay.lastPolicy?.advertisedCapabilities == ["local_files"] }
        // And something is actually claiming, which is the half
        // `willServeDispatchedWork` cannot see for itself.
        await world.settle { await world.relay.claimCount > 0 }
    }

    /// Turning the switch on before this Mac has paired does not sit for a
    /// heartbeat. Registration is kicked immediately, because that is the moment
    /// somebody is watching.
    @Test func switchingOnBeforePairingRegistersAtOnce() async {
        let world = await World.make()
        world.host.allowWorkOnThisMac = true
        world.host.allowsFileWork = true

        // No `start(for:)` yet: nothing is signed in, so nothing can be
        // registered and nothing must be.
        #expect(await world.registrar.registrationCount == 0)
        #expect(world.host.blocker == .signedOut)

        world.host.start(for: world.accountID)
        await world.settle { world.host.willServeDispatchedWork }
    }

    /// The failure that made this Mac lie.
    ///
    /// `WorkRemoteHost.run` returns outright on an error it cannot retry, leaving
    /// the actor alive with its loop set — so `activate()` answers true to anyone
    /// who asks again and the model's `remoteHost` stays non-nil. Because the
    /// model only ever built a host when it had none, that dead actor survived
    /// the rest of the launch and `willServeDispatchedWork` went on reporting a
    /// Mac that was claiming nothing. Switching Work on before granting anything
    /// is exactly the order that reaches it.
    @Test func aClaimLoopThatDiedIsReplacedRatherThanBelieved() async {
        let world = await World.make()
        // The relay refuses the first advertisement outright — the shape of a
        // host row the server still believes is disabled.
        await world.relay.refuseNextAdvertisement()

        world.host.start(for: world.accountID)
        await world.settle { world.host.pairedHostID != nil }
        world.host.take(.switchedOff)

        // The loop starts and dies on its first advertisement.
        await world.settle { await world.relay.advertiseFailureCount > 0 }

        // Now the capability arrives, as it would when somebody takes the second
        // step in front of them. The Mac has to end up genuinely serving.
        world.host.allowsFileWork = true
        await world.settle { await world.relay.claimCount > 0 }
        await world.settle { world.host.phase == .serving }
        #expect(world.host.blocker == nil)
    }

    /// Switching off has to stop the loop rather than wait for the next
    /// heartbeat, and has to say so. The window in which the relay still
    /// believes a Mac is serving is precisely when somebody reaches for a kill
    /// switch.
    @Test func switchingOffStopsServingImmediately() async {
        let world = await World.make()
        world.host.start(for: world.accountID)
        await world.settle { world.host.pairedHostID != nil }
        world.host.take(.switchedOff)
        world.host.allowsFileWork = true
        await world.settle { world.host.willServeDispatchedWork }

        world.host.stopServingWork()

        #expect(!world.host.willServeDispatchedWork)
        #expect(world.host.blocker == .switchedOff)
        #expect(world.host.phase == .off)
    }

    /// A Mac that registers with Work switched off says so. It used to sit under
    /// "Telling Juno what this Mac can do…" for the life of the process, beside a
    /// row that said Work was off — one state, two answers.
    @Test func aRegisteredMacThatIsSwitchedOffReadsAsOff() async {
        let world = await World.make()
        world.host.start(for: world.accountID)
        await world.settle { world.host.pairedHostID != nil }

        await world.settle { world.host.phase == .off }
        #expect(world.host.blocker == .switchedOff)
    }

    // MARK: - Fixtures

    /// A model over its own throwaway preference suite.
    ///
    /// Every switch is persisted, so two tests sharing `.standard` would share
    /// one Mac's standing consent — and the first one to switch Work on would
    /// leave it on for the rest of the run and for the developer's own app.
    private static func isolatedModel() -> DesktopWorkHostModel {
        DesktopWorkHostModel(defaults: Self.isolatedDefaults())
    }

    private static func isolatedDefaults() -> UserDefaults {
        UserDefaults(suiteName: "juno.work.tests.\(UUID().uuidString)")!
    }

    /// A one-way flag an Observation callback can raise.
    ///
    /// `withObservationTracking`'s `onChange` is `@Sendable` — it is called from
    /// wherever the mutation happened — so a captured local cannot be written
    /// from it. Locked rather than `nonisolated(unsafe)` because the whole point
    /// of the test is what a *notification* did, and a data race in the
    /// instrument would be indistinguishable from the defect it is watching for.
    private final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var raised = false

        func raise() { lock.withLock { raised = true } }
        var isRaised: Bool { lock.withLock { raised } }
    }

    /// Somewhere for a `@MainActor` closure to record what it was asked for
    /// without capturing a mutable local.
    @MainActor
    private final class Requested {
        var mode: WorkAccessMode?
    }

    /// A host model joined to fake transports, and the helpers to wait on it.
    @MainActor
    private struct World {
        let host: DesktopWorkHostModel
        let registrar: FakeRegistrar
        let relay: FakeRelay
        let accountID: AccountID

        static func make() async -> World {
            let defaults = DesktopWorkActivationTests.isolatedDefaults()
            // The identity Work registers under is Juno Code's device row, read
            // and never written here. Without it `registerNow` returns early and
            // this Mac never pairs — which is a real state on a first launch, and
            // not the one under test.
            defaults.set("device-under-test", forKey: "juno.code.deviceId")

            let host = DesktopWorkHostModel(defaults: defaults)
            let registrar = FakeRegistrar()
            let relay = FakeRelay()
            host.connect(
                registrar: registrar,
                relay: relay,
                executorFactory: { _, _ in FakeExecutor() },
                policyObserver: { _ in }
            )
            host.grantActions = DesktopWorkGrantActions(
                addFolder: { _ in "Reports" },
                setMode: { _, _ in },
                revoke: { _ in }
            )
            // macOS grants nothing in a test process, and file work needs nothing
            // from TCC — a grant *is* the permission. Stated rather than left to
            // the default so a machine with Accessibility granted to the test
            // runner cannot quietly widen what these advertise.
            host.systemPermissions = { .none }
            return World(
                host: host,
                registrar: registrar,
                relay: relay,
                accountID: try! AccountID("account-under-test")
            )
        }

        /// Waits for a condition the host reaches asynchronously.
        ///
        /// Polling rather than a continuation because what is being waited on is
        /// spread across a heartbeat task, an actor's activation and a claim
        /// loop, and a test that reached into any one of them would be testing
        /// the wiring it is supposed to observe from outside.
        func settle(
            within timeout: Duration = .seconds(5),
            _ condition: () async -> Bool,
            sourceLocation: SourceLocation = #_sourceLocation
        ) async {
            let deadline = ContinuousClock.now + timeout
            while ContinuousClock.now < deadline {
                if await condition() { return }
                try? await Task.sleep(for: .milliseconds(10))
            }
            Issue.record("Timed out waiting for the host to settle.", sourceLocation: sourceLocation)
        }
    }

    private actor FakeRegistrar: WorkHostRegistering {
        private(set) var registrationCount = 0
        private(set) var lastPolicy: WorkHostPolicy?

        func registerWorkHost(
            identity: WorkHostIdentity, policy: WorkHostPolicy, for accountID: AccountID
        ) async throws -> WorkHostRegistration {
            registrationCount += 1
            lastPolicy = policy
            return WorkHostRegistration(
                hostID: "host-under-test",
                routableCapabilities: policy.advertisedCapabilities
            )
        }
    }

    private actor FakeRelay: WorkRelaying {
        private(set) var lastPolicy: WorkHostPolicy?
        private(set) var claimCount = 0
        private(set) var advertiseFailureCount = 0
        private var refusalsRemaining = 0

        /// Makes the next advertisement fail in the one way the loop cannot
        /// retry, which is what kills it outright.
        func refuseNextAdvertisement() { refusalsRemaining += 1 }

        func advertiseWorkHost(
            hostID: String, policy: WorkHostPolicy, for accountID: AccountID
        ) async throws {
            if refusalsRemaining > 0 {
                refusalsRemaining -= 1
                advertiseFailureCount += 1
                throw WorkRemoteError.hostNotEnabled
            }
            lastPolicy = policy
        }

        func claimNextWorkCommand(
            hostID: String, for accountID: AccountID
        ) async throws -> WorkCommand? {
            claimCount += 1
            // The real route is a long poll, and a fake that answered instantly
            // would spin the loop as fast as the scheduler allows for the length
            // of the test.
            try await Task.sleep(for: .milliseconds(20))
            return nil
        }

        func acknowledgeWorkCommand(
            hostID: String, commandID: String, status: String,
            result: [String: JunoJSONValue]?, error: String?, for accountID: AccountID
        ) async throws {}
    }

    private struct FakeExecutor: WorkCommandExecuting {
        func execute(_ command: WorkCommand) async throws -> [String: JunoJSONValue] { [:] }
    }
}
