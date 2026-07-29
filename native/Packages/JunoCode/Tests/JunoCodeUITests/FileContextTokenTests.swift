import JunoCodeCore
import Testing
@testable import JunoCodeUI

struct CodeFileContextTokenTests {
    @Test
    func aTrailingAtTokenStartsFileDiscovery() {
        #expect(CodeFileContextToken(composerText: "@Comp")?.query == "Comp")
        #expect(
            CodeFileContextToken(composerText: "Please inspect @Composer.swift")?.query
                == "Composer.swift"
        )
    }

    @Test
    func aBareAtTokenHasAnEmptyQuery() {
        #expect(CodeFileContextToken(composerText: "@")?.query == "")
        #expect(CodeFileContextToken(composerText: "Look at @")?.query == "")
    }

    @Test
    func theTokenMustBeAtTheEndOfTheComposer() {
        #expect(CodeFileContextToken(composerText: "@Composer.swift next") == nil)
        #expect(CodeFileContextToken(composerText: "@Composer.swift\n") == nil)
    }

    @Test
    func emailAddressesNeverOpenFileDiscovery() {
        #expect(CodeFileContextToken(composerText: "liam@example.com") == nil)
        #expect(CodeFileContextToken(composerText: "Email liam@example.com") == nil)
    }

    @Test
    func filesystemAndURLPathsNeverOpenFileDiscovery() {
        #expect(CodeFileContextToken(composerText: "/tmp/@notes") == nil)
        #expect(CodeFileContextToken(composerText: "https://example.com/@notes") == nil)
        #expect(CodeFileContextToken(composerText: "@Sources/Composer") == nil)
    }

    @Test
    func anEscapedAtSignIsLiteralText() {
        #expect(CodeFileContextToken(composerText: #"\@Composer"#) == nil)
        #expect(CodeFileContextToken(composerText: #"Use \@Composer"#) == nil)
    }

    @Test
    func punctuationThatCannotAppearInAFileQueryIsRejected() {
        #expect(CodeFileContextToken(composerText: "@someone,") == nil)
        #expect(CodeFileContextToken(composerText: "@<file>") == nil)
    }

    @Test
    func choosingAResultReplacesOnlyTheActiveToken() {
        let text = "Compare this with @Comp"
        let token = CodeFileContextToken(composerText: text)
        #expect(
            token?.replacing(
                in: text,
                withPath: "native/JunoCodeUI/Views/Composer.swift"
            ) == "Compare this with @native/JunoCodeUI/Views/Composer.swift "
        )
    }

    @Test
    func insertionHandlesUnicodeBeforeTheToken() {
        let text = "Vérifie ceci 👋 @Comp"
        let token = CodeFileContextToken(composerText: text)
        #expect(
            token?.replacing(in: text, withPath: "Sources/Composer.swift")
                == "Vérifie ceci 👋 @Sources/Composer.swift "
        )
    }

    @Test
    func aTokenCannotRewriteDifferentComposerText() {
        let token = CodeFileContextToken(composerText: "Review @Comp")
        #expect(
            token?.replacing(in: "Review @Other", withPath: "Composer.swift")
                == "Review @Other"
        )
    }

    @Test
    func explicitContextRequiresTheExactVisibleReference() throws {
        let env = try WorkspacePath(".env")
        #expect(CodeFileContextToken.containsReference(to: env, in: "Review @.env"))
        #expect(CodeFileContextToken.containsReference(to: env, in: "Review @.env next"))
        #expect(!CodeFileContextToken.containsReference(to: env, in: "Review @.env.example"))
        #expect(!CodeFileContextToken.containsReference(to: env, in: #"Review \@.env"#))
    }
}

struct CodeFileContextSearchTests {
    @Test
    func exactAndPrefixFileNamesRankAheadOfSubstringMatches() throws {
        let entries = [
            FileEntry(
                path: try WorkspacePath("Sources/MyComposer.swift"),
                isDirectory: false,
                byteCount: 100
            ),
            FileEntry(
                path: try WorkspacePath("Sources/Composer.swift"),
                isDirectory: false,
                byteCount: 100
            ),
            FileEntry(
                path: try WorkspacePath("Composer"),
                isDirectory: false,
                byteCount: 100
            ),
        ]

        let ranked = CodeFileContextSearch.ranked(entries, query: "Composer")
        #expect(ranked.map(\.path.value) == [
            "Composer",
            "Sources/Composer.swift",
            "Sources/MyComposer.swift",
        ])
    }

    @Test
    func rankingIsStableWhenNamesTie() throws {
        let entries = [
            FileEntry(
                path: try WorkspacePath("Very/Deep/Feature.swift"),
                isDirectory: false,
                byteCount: nil
            ),
            FileEntry(
                path: try WorkspacePath("App/Feature.swift"),
                isDirectory: false,
                byteCount: nil
            ),
        ]

        #expect(
            CodeFileContextSearch.ranked(entries, query: "Feature").map(\.path.value)
                == ["App/Feature.swift", "Very/Deep/Feature.swift"]
        )
    }
}
