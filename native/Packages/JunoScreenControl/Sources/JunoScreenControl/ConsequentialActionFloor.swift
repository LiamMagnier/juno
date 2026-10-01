import Foundation

/// Why an action always asks.
public enum FloorReason: Hashable, Codable, Sendable {
    /// The target's title says it sends, buys, deletes, signs in…: the word.
    case consequentialControl(String)
    /// Return after typing in a mail, messaging or social app.
    case sendsMessage
    /// Anything beyond looking in a finance app.
    case financeApp
    /// The text looks like a password, key or token.
    case credentialText

    /// The sentence on the approval card.
    public var explanation: String {
        switch self {
        case let .consequentialControl(word):
            "This looks like a “\(word)” control, so Juno always asks, even in Full access."
        case .sendsMessage:
            "Return here sends what was typed, so Juno always asks, even in Full access."
        case .financeApp:
            "This is a finance app, so Juno always asks."
        case .credentialText:
            "This text looks like a password or key. Juno asks before typing it anywhere."
        }
    }
}

/// The always-confirm floor (CODE_AGENT_SPEC §3.3).
///
/// These actions ask in every mode, Full access included, and can never be
/// saved as an Always-allow rule. The floor is a rule, not the model's
/// judgement: it reads the target the service hit-tested, not what the model
/// says it is clicking (§3.8 rule 3).
public enum ConsequentialActionFloor {
    /// The words, by locale. Matched against the target's AX title,
    /// description and role description, as whole words, ignoring case and
    /// accents: "Envoyer", "Supprimer", "Send", "Delete…".
    public static let words: [String] = [
        // English
        "send", "submit", "post", "publish", "buy", "pay", "order", "purchase", "checkout",
        "check out", "transfer", "delete", "remove", "erase", "sign in", "log in", "login",
        "sign up", "accept", "agree", "allow", "install", "confirm", "place order", "pay now",
        "subscribe", "unsubscribe", "trash", "empty trash", "share", "reply", "forward",
        // French (the owner's Mac)
        "envoyer", "soumettre", "publier", "poster", "acheter", "payer", "commander", "transferer",
        "virement", "supprimer", "effacer", "retirer", "se connecter", "connexion", "accepter",
        "j'accepte", "autoriser", "installer", "confirmer", "valider", "partager", "repondre",
        "transferer", "s'abonner", "vider la corbeille", "mettre a la corbeille",
        // German
        "senden", "absenden", "kaufen", "bezahlen", "bestellen", "loschen", "entfernen", "anmelden",
        "akzeptieren", "zustimmen", "erlauben", "installieren", "bestatigen",
        // Spanish
        "enviar", "comprar", "pagar", "pedir", "eliminar", "borrar", "iniciar sesion", "aceptar",
        "permitir", "instalar", "confirmar",
    ]

    /// Keys that commit what was typed: Return, Enter, ⌘Return.
    static func commits(_ chord: String) -> Bool {
        guard let parsed = try? KeyChord.parse(chord) else { return false }
        if case .named(.return) = parsed.key { return true }
        return false
    }

    /// Space with no modifier: it presses the focused button, as a click
    /// would.
    static func pressesFocusedControl(_ chord: String) -> Bool {
        guard let parsed = try? KeyChord.parse(chord), parsed.modifiers.isEmpty else { return false }
        if case .named(.space) = parsed.key { return true }
        return false
    }

    /// ⌘⌫ and ⌘⌦ in any combination: Move to Trash in Finder, delete the
    /// message in Mail, delete the selection in most document apps.
    static func deletesSelection(_ chord: String) -> Bool {
        guard let parsed = try? KeyChord.parse(chord), parsed.modifiers.contains(.command) else { return false }
        switch parsed.key {
        case .named(.delete), .named(.forwardDelete): return true
        default: return false
        }
    }

    /// Whether typed text contains a line break, which is the Return key.
    static func containsReturn(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0 == "\n" || $0 == "\r" }
    }

    /// The floor for one action against its resolved target, or nil.
    ///
    /// - Parameters:
    ///   - action: what the model asked for.
    ///   - category: the target app's category.
    ///   - targetTexts: the hit-tested element's title, description, role
    ///     description and value-free label; for Return, also the window's
    ///     default button title.
    ///   - typedSinceLastCommit: whether this session typed into this app
    ///     since its last Return.
    ///   - looksLikeCredential: the credential test for typed text.
    public static func evaluate(
        action: ScreenAction,
        category: AppCategory,
        targetTexts: [String],
        typedSinceLastCommit: Bool,
        looksLikeCredential: (String) -> Bool = CredentialHeuristics.looksLikeCredential
    ) -> FloorReason? {
        if category == .finance, action.actionClass != .view {
            return .financeApp
        }
        switch action.kind {
        case .type:
            guard let text = action.text else { return nil }
            if looksLikeCredential(text) { return .credentialText }
            // A line break is typed as the Return key: in a messaging app it
            // sends, and in a dialog it presses the default button. Typing
            // "hi\n" must ask exactly as typing "hi" then pressing Return does.
            if containsReturn(text) {
                if category == .messaging { return .sendsMessage }
                if let word = matchingWord(in: targetTexts) { return .consequentialControl(word) }
            }
            return nil
        case .key, .holdKey:
            // A held key is one press and one release: holding Return sends
            // as surely as pressing it.
            guard let chord = action.text else { return nil }
            if commits(chord) {
                if category == .messaging, typedSinceLastCommit { return .sendsMessage }
                if let word = matchingWord(in: targetTexts) { return .consequentialControl(word) }
                return nil
            }
            if pressesFocusedControl(chord), let word = matchingWord(in: targetTexts) {
                return .consequentialControl(word)
            }
            if deletesSelection(chord) { return .consequentialControl("delete") }
            return nil
        case .leftClick, .doubleClick, .tripleClick, .middleClick, .leftMouseUp:
            if let word = matchingWord(in: targetTexts) { return .consequentialControl(word) }
            return nil
        default:
            return nil
        }
    }

    /// The first floor word any of `texts` contains as whole words.
    public static func matchingWord(in texts: [String]) -> String? {
        for text in texts {
            let tokens = tokenize(text)
            guard !tokens.isEmpty else { continue }
            let joined = " " + tokens.joined(separator: " ") + " "
            for word in words {
                let needle = " " + tokenize(word).joined(separator: " ") + " "
                if joined.contains(needle) { return word }
            }
        }
        return nil
    }

    /// Lowercased, accent-free words. Apostrophes stay inside a word
    /// ("j'accepte"); everything else that is not a letter or digit splits.
    static func tokenize(_ text: String) -> [String] {
        let folded = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .replacingOccurrences(of: "’", with: "'")
        var tokens: [String] = []
        var current = ""
        for character in folded {
            if character.isLetter || character.isNumber || character == "'" {
                current.append(character)
            } else if !current.isEmpty {
                tokens.append(current)
                current = ""
            }
        }
        if !current.isEmpty { tokens.append(current) }
        return tokens
    }
}

/// Whether typed text looks like a secret: a password the model is about to
/// type somewhere is never something it should do without the reader
/// (§3.8 rule 5). Deliberately eager — a false positive costs one question.
public enum CredentialHeuristics {
    static let prefixes = [
        "sk-", "sk_live_", "sk_test_", "rk_live_", "pk_live_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_",
        "github_pat_", "glpat-", "xoxb-", "xoxp-", "xoxa-", "xoxs-", "akia", "asia", "aiza", "ya29.",
        "eyj", "-----begin", "ssh-rsa ", "ssh-ed25519 ", "npm_", "pypi-", "shpat_", "sq0atp-",
    ]

    public static func looksLikeCredential(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let lowered = trimmed.lowercased()
        if prefixes.contains(where: { lowered.hasPrefix($0) }) { return true }
        if lowered.contains("password=") || lowered.contains("passwd=") || lowered.contains("secret=")
            || lowered.contains("api_key=") || lowered.contains("token=")
            || lowered.contains("-----begin")
        {
            return true
        }
        // Word by word, so a key inside a sentence ("the key is sk-live-…")
        // asks as a bare key does.
        let words = trimmed.split(whereSeparator: { $0.isWhitespace || $0 == "\"" || $0 == "'" || $0 == "`" })
        return words.contains { looksLikeSecretWord(String($0)) }
    }

    static func looksLikeSecretWord(_ word: String) -> Bool {
        let lowered = word.lowercased()
        // Inside a sentence a prefix counts only on a word as long as a key:
        // "Asiatique" starts like an AWS key id and is not one.
        if lowered.count >= 16, prefixes.contains(where: { lowered.hasPrefix($0) }) { return true }
        // One long unbroken run mixing letters and digits, the shape of a
        // generated key or a strong password.
        guard word.count >= 20 else { return false }
        let hasLetter = word.contains(where: \.isLetter)
        let hasDigit = word.contains(where: \.isNumber)
        let hasUpper = word.contains(where: \.isUppercase)
        let hasLower = word.contains(where: \.isLowercase)
        let isURL = lowered.hasPrefix("http://") || lowered.hasPrefix("https://") || lowered.contains("/")
        return hasLetter && hasDigit && hasUpper && hasLower && !isURL
    }
}

/// Which way a control moves the reader's clipboard, for the clipboard
/// grant: pasting reads it into the app, copying and cutting replace it.
///
/// The grant was checked only on ⌘V, ⌘C and ⌘X, so Edit › Paste through
/// `computer_menu`, or a click on Paste in a context menu, put the reader's
/// clipboard — often a password just copied from a manager — into an app
/// the reader never let read it.
public enum ClipboardControls {
    public enum Use: Hashable, Sendable {
        case read
        case write
    }

    static let pasteWords = ["paste", "coller", "einfugen", "pegar", "incolla", "plakken"]
    static let copyWords = [
        "copy", "cut", "copier", "couper", "kopieren", "ausschneiden", "copiar", "cortar", "copia", "taglia",
        "kopieren", "knippen",
    ]

    /// The clipboard use of a control with these texts, or nil.
    public static func use(of texts: [String]) -> Use? {
        for text in texts {
            let tokens = Set(ConsequentialActionFloor.tokenize(text))
            if pasteWords.contains(where: tokens.contains) { return .read }
            if copyWords.contains(where: tokens.contains) { return .write }
        }
        return nil
    }
}
