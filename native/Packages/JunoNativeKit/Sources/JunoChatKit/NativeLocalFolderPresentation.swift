import Foundation

/// The words a folder call's row wears (`local_folder` records, whose
/// `args.action` says which tool ran). One short line per call — "Reading
/// march.csv", "Ran pandoc notes.md -o notes.docx" — with the full path,
/// arguments and output behind the row's disclosure, as every tool row has.
public enum NativeLocalFolderPresentation {
    public static let canonicalTool = "local_folder"

    /// The line for a call that is running (or waiting on the approval card).
    public static func runningLine(_ call: NativeToolCall) -> NativeRunPhraseLine {
        line(call, done: false)
    }

    /// The line for a call that finished.
    public static func doneLine(_ call: NativeToolCall) -> NativeRunPhraseLine {
        line(call, done: true)
    }

    /// The glyph, as a `JunoIcon` raw name.
    public static func iconName(_ call: NativeToolCall) -> String {
        switch call.args["action"] {
        case "run": "terminal"
        case "write": "filePlus"
        case "make_dir": "folderPlus"
        case "edit": "pencil"
        case "search": "search"
        case "list", "move": "folderOpen"
        case "open": "external"
        case "delete": "trash"
        default: "file"
        }
    }

    static func line(_ call: NativeToolCall, done: Bool) -> NativeRunPhraseLine {
        let path = call.args["path"].flatMap(lastComponent)
        let to = call.args["to"].flatMap(lastComponent)
        func say(_ running: String, _ finished: String, _ argument: NativeRunPhrase.Part?) -> NativeRunPhraseLine {
            let words = done ? finished : running
            guard let argument else { return NativeRunPhraseLine([NativeRunPhrase(words)]) }
            return NativeRunPhraseLine([NativeRunPhrase([.phrase(words), argument])])
        }
        switch call.args["action"] {
        case "list":
            return say("Looking in", "Looked in", .file(path ?? "the folder"))
        case "read":
            return say("Reading", "Read", path.map(NativeRunPhrase.Part.file))
        case "search":
            let query = call.args["query"].flatMap { $0.isEmpty ? nil : $0 }
            return say("Searching the folder for", "Searched the folder for", query.map(NativeRunPhrase.Part.quote))
        case "write":
            return say("Writing", "Wrote", path.map(NativeRunPhrase.Part.file))
        case "edit":
            return say("Editing", "Edited", path.map(NativeRunPhrase.Part.file))
        case "move":
            // A rename stays in its folder; a move names where it went.
            let fromFolder = call.args["path"].map(parentFolder)
            let toFolder = call.args["to"].map(parentFolder)
            if let to, fromFolder == toFolder {
                var line = say("Renaming", "Renamed", path.map(NativeRunPhrase.Part.file))
                line.phrases.append(NativeRunPhrase([.phrase("to"), .file(to)]))
                return line
            }
            var line = say("Moving", "Moved", path.map(NativeRunPhrase.Part.file))
            if let toFolder {
                line.phrases.append(NativeRunPhrase([.phrase("to"), .file(toFolder.isEmpty ? "the folder" : toFolder)]))
            }
            return line
        case "make_dir":
            return say("Making folder", "Made folder", path.map(NativeRunPhrase.Part.file))
        case "delete":
            return say("Deleting", "Deleted", path.map(NativeRunPhrase.Part.file))
        case "run":
            let command = call.args["command"].map { singleLine($0, limit: 48) }
            return say("Running", "Ran", command.map(NativeRunPhrase.Part.label))
        case "open":
            if call.args["reveal"] == "true" {
                return say("Showing in Finder", "Showed in Finder", path.map(NativeRunPhrase.Part.file))
            }
            return say("Opening", "Opened", .file(path ?? "the folder"))
        default:
            return say("Working in the folder", "Worked in the folder", nil)
        }
    }

    /// The name a person reads: the last component of a folder-relative path.
    static func lastComponent(_ path: String) -> String? {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return name.isEmpty ? nil : name
    }

    /// The folder a path sits in, relative to the root ("" for the root).
    static func parentFolder(_ path: String) -> String {
        let parts = path.split(separator: "/")
        return parts.dropLast().joined(separator: "/")
    }

    static func singleLine(_ text: String, limit: Int) -> String {
        let flat = text.split(whereSeparator: \.isNewline).joined(separator: " ")
        return flat.count > limit ? String(flat.prefix(limit - 1)) + "…" : flat
    }
}
