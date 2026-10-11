import Darwin
import Foundation

/// Which project folders Alevr may move to the Trash when a project is
/// removed, and why not when it may not. Pure: the confirmation asks it to
/// decide whether to offer the checkbox, and the removal asks it again at the
/// last moment.
///
/// Never offered for the home folder or anything above it, a folder the
/// system or the reader's own Mac layout owns (the volume roots, `/System`,
/// `~/Library`, Desktop, Documents, Downloads and their kind), or a folder
/// that holds another project. Only ever the chosen folder itself: nothing
/// outside it is touched.
public enum ProjectTrashPolicy {
    /// The reader's real home folder: the account's, not a sandbox container's.
    public static var realHome: URL {
        if let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: dir), isDirectory: true)
        }
        return URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    }

    /// Top-level folders the system owns.
    public static let systemRoots = [
        "/System", "/Library", "/Applications", "/Users", "/Volumes", "/usr", "/bin", "/sbin",
        "/private", "/etc", "/var", "/tmp", "/opt", "/cores", "/dev", "/Network",
    ]

    /// Folders in the home folder that are the Mac's layout, not a project.
    static let homeLayout = [
        "Library", "Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures",
        "Public", "Applications", "Developer", "Sites",
    ]

    public static func refusal(
        for folder: URL,
        otherProjects: [URL],
        home: URL = realHome,
        systemRoots: [String] = ProjectTrashPolicy.systemRoots,
        fileManager: FileManager = .default
    ) -> String? {
        let path = canonical(folder)
        let homePath = canonical(home)
        let parts = path.split(separator: "/").map(String.init)
        if parts.isEmpty { return "This is your Mac's startup disk, so it stays where it is." }
        if path == homePath { return "This is your home folder, so it stays where it is." }
        if homePath.hasPrefix(path + "/") { return "This folder holds your home folder, so it stays where it is." }
        for root in systemRoots where path == root || (root != "/Users" && root != "/Volumes" && path.hasPrefix(root + "/")) {
            return "This is a system folder, so it stays where it is."
        }
        // A volume's root (`/Volumes/Disk`) or a home folder's parent.
        if systemRoots.contains("/Volumes"), parts.first == "Volumes", parts.count <= 2 { return "This is a disk, so it stays where it is." }
        if systemRoots.contains("/Users"), parts.first == "Users", parts.count <= 2 { return "This is someone's home folder, so it stays where it is." }
        for name in homeLayout {
            let protected = homePath + "/" + name
            if path == protected || (name == "Library" && path.hasPrefix(protected + "/")) {
                return "This is one of your Mac's own folders, so it stays where it is."
            }
        }
        if let inside = otherProjects.first(where: { other in
            let otherPath = canonical(other)
            return otherPath == path || otherPath.hasPrefix(path + "/")
        }) {
            return "This folder holds another project, \(inside.lastPathComponent), so it stays where it is."
        }
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return "This folder is no longer on your Mac."
        }
        return nil
    }

    /// The absolute path with `..`, `.` and symbolic links resolved, without
    /// a trailing slash.
    static func canonical(_ url: URL) -> String {
        var path = url.standardizedFileURL.resolvingSymlinksInPath().path
        while path.count > 1, path.hasSuffix("/") { path.removeLast() }
        return path == "/" ? "" : path
    }
}
