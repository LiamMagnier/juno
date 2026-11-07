import JunoDesignSystem
import SwiftUI

/// The same six starting points as Orbit on the web, with native focus and controls.
struct NativeOrbitCapabilities: View {
    let choose: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("What will you put in motion?")
                    .junoType(JunoType.bodyLarge.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text("Start with a focus. Make it your own.")
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
                    }
                    .buttonStyle(.plain)
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
