import Foundation

// MARK: - Classification

/// How far a piece of content may travel.
///
/// Raw values match `WORK_SENSITIVITIES` in `src/lib/work/domain.ts`. Named
/// `AutomationSensitivity` rather than claiming the shared name in a module that
/// is not Core, but the strings on the wire are the same strings — a mismatch
/// here is a classification the web app cannot render, not a naming preference.
public enum AutomationSensitivity: String, Codable, CaseIterable, Sendable, Comparable {
    case publicContent = "public"
    case internalContent = "internal"
    case confidential
    case restricted

    private var rank: Int {
        switch self {
        case .publicContent: 0
        case .internalContent: 1
        case .confidential: 2
        case .restricted: 3
        }
    }

    public static func < (lhs: AutomationSensitivity, rhs: AutomationSensitivity) -> Bool {
        lhs.rank < rhs.rank
    }

    /// The highest of several classifications. Sensitivity only ever rises: one
    /// password field on a page of public marketing copy makes the page a page
    /// with a password field on it.
    public static func highest(_ values: [AutomationSensitivity]) -> AutomationSensitivity {
        values.max() ?? .publicContent
    }
}

// MARK: - What is being looked at

/// One field, as the accessibility tree describes it.
///
/// Every property here is *metadata*: a role, a subrole, the label somebody put
/// next to the box. The value inside the box is deliberately absent, because a
/// descriptor carrying it would be a descriptor that puts a password into every
/// log line that prints one.
public struct AccessibilityFieldDescriptor: Hashable, Sendable {
    /// The tier's own identity for the element, used to act on it later.
    public let elementID: String
    /// `AXTextField`, `AXSecureTextField`, `AXButton`, an HTML input type — the
    /// vocabulary is the tier's, and this type does not interpret it beyond the
    /// checks below.
    public let role: String
    public let subrole: String?
    /// The visible label, placeholder or accessibility description.
    public let label: String?
    /// Whether the platform itself says this is a secure entry field. The
    /// strongest signal available, and still only a signal: a web page can build
    /// a password box out of a plain input and a font.
    public let isSecureTextEntry: Bool
    /// An autocomplete or content-type hint, when the tier has one:
    /// `current-password`, `cc-number`, `one-time-code`.
    public let contentHint: String?
    /// Where the field is on screen, when the tier knows. Used to build a
    /// redaction plan; nil means "cannot be redacted", which
    /// ``ScreenshotPolicy`` treats as a reason to refuse rather than a reason to
    /// proceed.
    public let bounds: AutomationRect?

    public init(
        elementID: String,
        role: String,
        subrole: String? = nil,
        label: String? = nil,
        isSecureTextEntry: Bool = false,
        contentHint: String? = nil,
        bounds: AutomationRect? = nil
    ) {
        self.elementID = elementID
        self.role = role
        self.subrole = subrole
        self.label = label
        self.isSecureTextEntry = isSecureTextEntry
        self.contentHint = contentHint
        self.bounds = bounds
    }
}

/// What kind of secret a surface holds.
public enum SensitiveSurfaceKind: String, Codable, CaseIterable, Sendable {
    case password
    case oneTimeCode = "one_time_code"
    case paymentCard = "payment_card"
    case bankAccount = "bank_account"
    case governmentIdentifier = "government_identifier"
    case apiCredential = "api_credential"

    /// The clause used in a refusal a person reads.
    public var phrase: String {
        switch self {
        case .password: "a password"
        case .oneTimeCode: "a one-time code"
        case .paymentCard: "a card number"
        case .bankAccount: "a bank account number"
        case .governmentIdentifier: "a government identity number"
        case .apiCredential: "an API key"
        }
    }

    /// Every kind is `restricted`.
    ///
    /// Not an oversight and not a placeholder: none of these may appear in an
    /// image that leaves the Mac, and a scale where some secrets are merely
    /// confidential would be a scale somebody uses to justify relaying one.
    public var sensitivity: AutomationSensitivity { .restricted }
}

/// Why a surface was flagged.
public enum SensitiveSurfaceSignal: String, Codable, CaseIterable, Sendable {
    /// The platform marked the field as secure entry.
    case secureTextEntry = "secure_text_entry"
    /// The accessibility tree or the page's own attributes named it.
    case declaredAttribute = "declared_attribute"
    /// The label next to it says what goes in it.
    case labelWording = "label_wording"
    /// The value on the page has the shape of a secret.
    case valueShape = "value_shape"
}

/// A field or region that must not be typed into or captured.
public struct SensitiveSurface: Hashable, Sendable {
    public let kind: SensitiveSurfaceKind
    public let signal: SensitiveSurfaceSignal
    /// The element it was found on, when it came from a field rather than from
    /// scanning text.
    public let elementID: String?
    /// Where to paint over, when the tier could say. Nil is not "nothing to
    /// redact"; it is "this cannot be redacted", and callers treat it that way.
    public let region: AutomationRect?

    public init(
        kind: SensitiveSurfaceKind,
        signal: SensitiveSurfaceSignal,
        elementID: String? = nil,
        region: AutomationRect? = nil
    ) {
        self.kind = kind
        self.signal = signal
        self.elementID = elementID
        self.region = region
    }
}

// MARK: - Detection

/// Spots fields and values that must not be typed into or captured.
///
/// ## Detection is a signal, not a boundary
///
/// Everything in this type is a heuristic over other people's markup. A login
/// form built from a plain `<input>` and a custom font has no secure-entry flag;
/// a label reading "Sikkerhetskode" is not in the word list; a card number split
/// across four boxes passes no Luhn check. Treating this as containment means
/// shipping a system whose safety depends on a stranger's HTML being polite.
///
/// **The real boundary is two things, and neither of them is here.** The first
/// is ``AutomationPermission``: a default-deny allowlist, a block that beats the
/// allowlist, and restricted categories that are refused even when explicitly
/// allowed — so the password manager and the bank are unreachable whether or not
/// any field on them is recognised. The second is the approval receipt from
/// ``WorkApprovalCoordinator``: anything that sends, publishes, buys, deletes or
/// changes a setting stops and asks a person, bound to the exact action.
///
/// What this type is *for* is the two jobs a boundary cannot do: refusing to
/// type into a box that announces itself as a password, and building the
/// redaction plan ``ScreenshotPolicy`` applies before an image is stored. Both
/// are improvements on a system that is already safe without them.
public enum SensitiveSurfaceDetector {
    /// The surface this field is, or nil.
    public static func classify(_ field: AccessibilityFieldDescriptor) -> SensitiveSurface? {
        if field.isSecureTextEntry {
            return SensitiveSurface(
                kind: .password,
                signal: .secureTextEntry,
                elementID: field.elementID,
                region: field.bounds
            )
        }
        let role = normalize(field.role)
        let subrole = normalize(field.subrole ?? "")
        if role.contains("securetextfield") || subrole.contains("securetextfield")
            || role == "passwordfield"
        {
            return SensitiveSurface(
                kind: .password,
                signal: .secureTextEntry,
                elementID: field.elementID,
                region: field.bounds
            )
        }
        if let hint = field.contentHint, let kind = kind(forHint: normalize(hint)) {
            return SensitiveSurface(
                kind: kind,
                signal: .declaredAttribute,
                elementID: field.elementID,
                region: field.bounds
            )
        }
        if let label = field.label, let kind = kind(forLabel: normalize(label)) {
            return SensitiveSurface(
                kind: kind,
                signal: .labelWording,
                elementID: field.elementID,
                region: field.bounds
            )
        }
        return nil
    }

    /// Every sensitive field in a set of descriptors.
    public static func classify(
        fields: [AccessibilityFieldDescriptor]
    ) -> [SensitiveSurface] {
        fields.compactMap(classify)
    }

    /// Credential-shaped values in a piece of text.
    ///
    /// Used on text about to be typed, and on text read back from a page before
    /// it reaches a model. Deliberately shape-based and deliberately narrow:
    /// this returns what a secret *looks* like, and a wider net would flag every
    /// order number on every receipt and teach whoever reads the refusals to
    /// ignore them.
    public static func scan(_ text: String) -> [SensitiveSurface] {
        var found: [SensitiveSurface] = []
        var seen: Set<SensitiveSurfaceKind> = []

        func add(_ kind: SensitiveSurfaceKind) {
            guard seen.insert(kind).inserted else { return }
            found.append(SensitiveSurface(kind: kind, signal: .valueShape))
        }

        for token in tokens(in: text) {
            if isAPICredential(token) { add(.apiCredential) }
            if isGovernmentIdentifier(token) { add(.governmentIdentifier) }
        }
        if containsPaymentCardNumber(text) { add(.paymentCard) }
        return found
    }

    /// The classification of a page or window, given what was found on it.
    public static func sensitivity(of surfaces: [SensitiveSurface]) -> AutomationSensitivity {
        AutomationSensitivity.highest(surfaces.map(\.kind.sensitivity))
    }

    /// The regions a screenshot must have painted over before it is stored.
    public static func redactionRegions(of surfaces: [SensitiveSurface]) -> [AutomationRect] {
        surfaces.compactMap(\.region)
    }

    /// Whether every sensitive surface found can actually be painted over.
    ///
    /// A surface with no region is one the capture cannot hide, which is a
    /// reason to refuse the capture rather than to store an image with a
    /// password in it and a note saying redaction was attempted.
    public static func allSurfacesAreRedactable(_ surfaces: [SensitiveSurface]) -> Bool {
        surfaces.allSatisfy { $0.region != nil }
    }

    // MARK: - Word lists

    private static func kind(forHint hint: String) -> SensitiveSurfaceKind? {
        if hint.contains("password") { return .password }
        if hint.contains("onetimecode") || hint.contains("otp") { return .oneTimeCode }
        if hint.contains("ccnumber") || hint.contains("cccsc") || hint.contains("cardnumber") {
            return .paymentCard
        }
        return nil
    }

    private static func kind(forLabel label: String) -> SensitiveSurfaceKind? {
        // "pin" on its own is deliberately absent. It is a substring of
        // "shipping", so a bare match turns every address form into a password
        // field and teaches whoever reads the refusals to ignore them.
        for word in ["password", "passphrase", "passcode", "pincode", "pinnumber"]
        where label.contains(word) {
            return .password
        }
        for word in ["onetimecode", "verificationcode", "securitycode", "authcode", "2fa"]
        where label.contains(word) {
            return .oneTimeCode
        }
        for word in ["cardnumber", "creditcard", "debitcard", "cvv", "cvc", "cardsecurity"]
        where label.contains(word) {
            return .paymentCard
        }
        for word in ["accountnumber", "routingnumber", "sortcode", "iban"]
        where label.contains(word) {
            return .bankAccount
        }
        for word in [
            "socialsecurity", "ssn", "nationalinsurance", "passportnumber", "taxid",
            "driverslicense",
        ] where label.contains(word) {
            return .governmentIdentifier
        }
        for word in ["apikey", "secretkey", "accesstoken", "clientsecret", "privatekey"]
        where label.contains(word) {
            return .apiCredential
        }
        return nil
    }

    // MARK: - Shapes

    /// Lowercased with every non-alphanumeric removed, so "Card Number",
    /// "card_number" and "card-number" are one word.
    ///
    /// Stripping separators is what makes a short word list workable. Without
    /// it, the list has to enumerate every way a designer might punctuate the
    /// same phrase, and the one spelling nobody thought of is the one on the
    /// page that matters.
    private static func normalize(_ value: String) -> String {
        String(value.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
    }

    private static func tokens(in text: String) -> [Substring] {
        text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" || $0 == "\r" })
    }

    private static func isAPICredential(_ token: Substring) -> Bool {
        let value = String(token)
        let prefixes = ["sk-", "sk_live_", "sk_test_", "pk_live_", "ghp_", "gho_", "github_pat_",
                        "xoxb-", "xoxp-", "AKIA", "ASIA", "AIza", "-----BEGIN"]
        for prefix in prefixes where value.hasPrefix(prefix) {
            // A prefix alone is not enough: `sk-` is also the start of an
            // ordinary word in several languages, and flagging it would refuse
            // sentences. A key is a prefix followed by enough entropy to be one.
            return value.count >= prefix.count + 12 || prefix == "-----BEGIN"
        }
        return false
    }

    private static func isGovernmentIdentifier(_ token: Substring) -> Bool {
        // US Social Security number, the one government identifier with a shape
        // distinctive enough to match without also matching dates and postcodes.
        let characters = Array(token)
        guard characters.count == 11, characters[3] == "-", characters[6] == "-" else {
            return false
        }
        for (index, character) in characters.enumerated() where index != 3 && index != 6 {
            guard character.isNumber else { return false }
        }
        return true
    }

    private static func containsPaymentCardNumber(_ text: String) -> Bool {
        // Digits are gathered across single spaces and dashes, because that is
        // how card numbers are written on the pages that ask for them and a
        // check matching only sixteen unbroken digits would miss every one of
        // them. Two separators in a row end the run, so two short unrelated
        // numbers on either side of a gap do not fuse into one long candidate.
        var run: [Character] = []
        var separatorPending = false
        for character in text {
            if character.isNumber {
                run.append(character)
                separatorPending = false
            } else if (character == " " || character == "-") && !run.isEmpty && !separatorPending {
                separatorPending = true
            } else {
                if isCardNumber(run) { return true }
                run.removeAll(keepingCapacity: true)
                separatorPending = false
            }
        }
        return isCardNumber(run)
    }

    private static func isCardNumber(_ digits: [Character]) -> Bool {
        guard digits.count >= 13, digits.count <= 19 else { return false }
        var sum = 0
        var double = false
        for character in digits.reversed() {
            guard let value = character.wholeNumberValue else { return false }
            var digit = value
            if double {
                digit *= 2
                if digit > 9 { digit -= 9 }
            }
            sum += digit
            double.toggle()
        }
        return sum % 10 == 0
    }
}
