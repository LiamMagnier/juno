import JunoDesignSystem
import SwiftUI

/// The same six starting points as Orbit on the web, with native focus and controls.
struct NativeOrbitCapabilities: View {
    var gettingStarted = false
    let choose: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            if gettingStarted {
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    ForEach(Array(NativeAgentSetupStep.all.enumerated()), id: \.element.id) { index, step in
                        HStack(alignment: .top, spacing: JunoSpace.cozy) {
                            Text("\(index + 1)")
                                .junoType(.caption)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .frame(width: 24, height: 24)
                                .overlay(Circle().strokeBorder(Color.junoBorder, lineWidth: 1))
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                                Text(step.title).junoType(JunoType.ui.weight(.medium))
                                Text(step.detail).junoType(.ui).foregroundStyle(Color.junoSecondaryInk)
                            }
                            .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.vertical, JunoSpace.regular)
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Choose a starting point")
                    .junoType(JunoType.bodyLarge.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text("Pick a job to fill the draft. You can edit it before creating your agent.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: JunoSpace.snug)], spacing: JunoSpace.snug) {
                ForEach(NativeOrbitCapability.all) { capability in
                    Button { choose(capability.prompt) } label: {
                        HStack(alignment: .top, spacing: JunoSpace.cozy) {
                            JunoIconView(capability.icon, size: 18)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .frame(width: 32, height: 32)
                                .background(Color.junoRaised, in: RoundedRectangle(cornerRadius: JunoRadius.control))
                            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                                Text(capability.title)
                                    .junoType(JunoType.ui.weight(.medium))
                                    .foregroundStyle(Color.junoForeground)
                                Text(capability.detail)
                                    .junoType(.caption)
                                    .foregroundStyle(Color.junoSecondaryInk)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(JunoSpace.cozy)
                        .frame(minWidth: 44, maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(.rect(cornerRadius: JunoRadius.control))
                        .background(Color.junoCard, in: RoundedRectangle(cornerRadius: JunoRadius.control))
                        .overlay {
                            RoundedRectangle(cornerRadius: JunoRadius.control)
                                .strokeBorder(Color.junoBorder, lineWidth: 1)
                        }
                    }
                    .buttonStyle(JunoPressButtonStyle())
                    .accessibilityHint("Fills the new agent draft")
                }
            }
            Text("Available tools depend on your plan, connected apps, and computer setup.")
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, JunoSpace.expanse)
    }
}
