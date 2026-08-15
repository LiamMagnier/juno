import Testing
@testable import JunoDesktop

struct DesktopArtifactComponentTests {
    @Test
    func extractsEditableElementsAndTheirStableSelectors() {
        let source = #"""
            <!doctype html>
            <html>
              <head><style>.hero { color: red }</style></head>
              <body>
                <header id="site-header"></header>
                <main class="hero shell"></main>
                <script>document.body.dataset.ready = "true"</script>
              </body>
            </html>
            """#

        let components = DesktopArtifactComponent.extract(from: source)

        #expect(components.map(\.tag) == ["body", "header", "main"])
        #expect(components[1].shortLabel == "#site-header")
        #expect(components[2].shortLabel == ".hero")
        #expect(components[2].promptDescription.contains("hero shell"))
    }

    @Test
    func repeatedComponentClassesAreCollapsedAndTheMenuIsBounded() {
        let repeated = (0..<80).map { _ in #"<article class="card"></article>"# }.joined()
        let components = DesktopArtifactComponent.extract(from: repeated)

        #expect(components.count == 1)
        #expect(components.first?.label == "<article>  .card")
        #expect(components.count <= 60)
    }
}
