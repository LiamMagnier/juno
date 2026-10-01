import Darwin
import Foundation

/// Which process owns a listening TCP socket, read from the kernel with
/// `libproc` (CODE_AGENT_SPEC §4.2, PV-8, PV-9, PV-15).
///
/// A dev server's printed URL is only a hint: a proxy target, a database URL or
/// a sibling app's address often prints first. A URL counts as the server's
/// only when a socket listening on its port belongs to the server's process
/// group, and this is how that is checked: `proc_listpgrppids` for the group,
/// `PROC_PIDLISTFDS` for each member's descriptors, `PROC_PIDFDSOCKETINFO` for
/// each socket. No string matching, no DNS.
public enum ListeningSocketOwnership {
    /// One listening TCP socket.
    public struct Socket: Hashable, Sendable {
        public enum Address: Hashable, Sendable {
            /// `0.0.0.0` or `::`: every interface, loopback included.
            case wildcard
            /// `127.x.x.x` or `::1`.
            case loopback
            /// A specific non-loopback interface (a LAN address).
            case other(String)
        }

        public let pid: pid_t
        public let port: Int
        public let isIPv6: Bool
        public let address: Address

        /// Whether a browser on this Mac can reach it at `localhost`.
        public var isReachableOnLoopback: Bool {
            switch address {
            case .wildcard, .loopback: true
            case .other: false
            }
        }
    }

    /// A process, described for a sentence ("port 3000 is used by node, pid
    /// 4211").
    public struct ProcessDescription: Hashable, Sendable {
        public let pid: pid_t
        public let name: String

        public var sentence: String { "\(name) (pid \(pid))" }
    }

    // MARK: - Groups

    /// Every process in the group `pgid`, plus the descendants of its leader
    /// that moved to a group of their own.
    public static func processes(inGroup pgid: pid_t) -> [pid_t] {
        guard pgid > 0 else { return [] }
        var members = Set(groupMembers(pgid))
        if isAlive(pgid) {
            members.insert(pgid)
            var frontier = [pgid]
            var visited: Set<pid_t> = []
            while let next = frontier.popLast(), visited.count < 512 {
                guard visited.insert(next).inserted else { continue }
                let children = childProcesses(of: next)
                members.formUnion(children)
                frontier += children
            }
        }
        return members.sorted()
    }

    static func groupMembers(_ pgid: pid_t) -> [pid_t] {
        var buffer = [pid_t](repeating: 0, count: 256)
        let count = buffer.withUnsafeMutableBytes { raw in
            proc_listpgrppids(pgid, raw.baseAddress, Int32(raw.count))
        }
        guard count > 0 else { return [] }
        return Array(buffer.prefix(Int(count))).filter { $0 > 0 }
    }

    static func childProcesses(of pid: pid_t) -> [pid_t] {
        var buffer = [pid_t](repeating: 0, count: 256)
        let count = buffer.withUnsafeMutableBytes { raw in
            proc_listchildpids(pid, raw.baseAddress, Int32(raw.count))
        }
        guard count > 0 else { return [] }
        return Array(buffer.prefix(Int(count))).filter { $0 > 0 }
    }

    // MARK: - Sockets

    /// The listening TCP sockets of `pid`. Empty when the process is gone or
    /// belongs to another user.
    public static func listeningSockets(of pid: pid_t) -> [Socket] {
        let bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard bytes > 0 else { return [] }
        let capacity = Int(bytes) / MemoryLayout<proc_fdinfo>.stride + 16
        var descriptors = [proc_fdinfo](repeating: proc_fdinfo(), count: capacity)
        let filled = descriptors.withUnsafeMutableBytes { raw in
            proc_pidinfo(pid, PROC_PIDLISTFDS, 0, raw.baseAddress, Int32(raw.count))
        }
        guard filled > 0 else { return [] }
        let count = Int(filled) / MemoryLayout<proc_fdinfo>.stride
        var sockets: [Socket] = []
        for descriptor in descriptors.prefix(count) where descriptor.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET) {
            var info = socket_fdinfo()
            let size = proc_pidfdinfo(
                pid, descriptor.proc_fd, PROC_PIDFDSOCKETINFO, &info, Int32(MemoryLayout<socket_fdinfo>.size)
            )
            guard size == Int32(MemoryLayout<socket_fdinfo>.size),
                  info.psi.soi_kind == SOCKINFO_TCP
            else { continue }
            let tcp = info.psi.soi_proto.pri_tcp
            guard tcp.tcpsi_state == TSI_S_LISTEN else { continue }
            let inet = tcp.tcpsi_ini
            let port = Int(UInt16(bigEndian: UInt16(truncatingIfNeeded: inet.insi_lport)))
            guard port > 0 else { continue }
            let isIPv6 = inet.insi_vflag & UInt8(INI_IPV6) != 0
            sockets.append(Socket(pid: pid, port: port, isIPv6: isIPv6, address: address(of: inet, isIPv6: isIPv6)))
        }
        return sockets
    }

    private static func address(of inet: in_sockinfo, isIPv6: Bool) -> Socket.Address {
        if isIPv6 {
            var raw = inet.insi_laddr.ina_6
            let bytes = withUnsafeBytes(of: &raw) { Array($0) }
            if bytes.allSatisfy({ $0 == 0 }) { return .wildcard }
            if bytes.dropLast().allSatisfy({ $0 == 0 }), bytes.last == 1 { return .loopback }
            // IPv4-mapped (::ffff:a.b.c.d).
            if bytes[0..<10].allSatisfy({ $0 == 0 }), bytes[10] == 0xFF, bytes[11] == 0xFF {
                return ipv4Address(bytes[12], bytes[13], bytes[14], bytes[15])
            }
            var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
            inet_ntop(AF_INET6, &raw, &buffer, socklen_t(buffer.count))
            return .other(decodeCString(buffer))
        }
        let value = UInt32(bigEndian: inet.insi_laddr.ina_46.i46a_addr4.s_addr)
        return ipv4Address(
            UInt8(value >> 24), UInt8((value >> 16) & 0xFF), UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF)
        )
    }

    private static func ipv4Address(_ a: UInt8, _ b: UInt8, _ c: UInt8, _ d: UInt8) -> Socket.Address {
        if a == 0, b == 0, c == 0, d == 0 { return .wildcard }
        if a == 127 { return .loopback }
        return .other("\(a).\(b).\(c).\(d)")
    }

    /// The listening sockets of every process in the group `pgid`.
    public static func listeningSockets(inProcessGroup pgid: pid_t) -> [Socket] {
        processes(inGroup: pgid).flatMap(listeningSockets(of:))
    }

    /// Whether the group `pgid` listens on `port` somewhere a browser on this
    /// Mac can reach at loopback.
    public static func groupListensOnLoopback(port: Int, processGroup pgid: pid_t) -> Bool {
        listeningSockets(inProcessGroup: pgid).contains { $0.port == port && $0.isReachableOnLoopback }
    }

    /// Whether the group `pgid` listens on `port` at all.
    public static func groupListens(port: Int, processGroup pgid: pid_t) -> Bool {
        listeningSockets(inProcessGroup: pgid).contains { $0.port == port }
    }

    /// Who listens on `port`, among the processes this user can inspect.
    public static func owner(ofPort port: Int) -> ProcessDescription? {
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { return nil }
        var pids = [pid_t](repeating: 0, count: Int(count) + 64)
        let filled = pids.withUnsafeMutableBytes { raw in
            proc_listallpids(raw.baseAddress, Int32(raw.count))
        }
        guard filled > 0 else { return nil }
        for pid in pids.prefix(Int(filled)) where pid > 0 {
            if listeningSockets(of: pid).contains(where: { $0.port == port }) {
                return ProcessDescription(pid: pid, name: processName(pid) ?? "a process")
            }
        }
        return nil
    }

    // MARK: - Processes

    public static func isAlive(_ pid: pid_t) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    public static func processName(_ pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 256)
        let length = proc_name(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return decodeCString(buffer)
    }

    static func decodeCString(_ buffer: [CChar]) -> String {
        String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    /// When `pid` started, to tell a process from a later one that reused its
    /// pid. Nil when it is gone.
    public static func startTime(of pid: pid_t) -> ProcessStartTime? {
        var info = proc_bsdinfo()
        let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        guard size == Int32(MemoryLayout<proc_bsdinfo>.size) else { return nil }
        return ProcessStartTime(seconds: Int64(info.pbi_start_tvsec), microseconds: Int64(info.pbi_start_tvusec))
    }

    /// The process group `pid` is in.
    public static func processGroup(of pid: pid_t) -> pid_t? {
        let group = getpgid(pid)
        return group > 0 ? group : nil
    }
}

/// A process's start time, as the kernel records it.
public struct ProcessStartTime: Codable, Hashable, Sendable {
    public var seconds: Int64
    public var microseconds: Int64

    public init(seconds: Int64, microseconds: Int64) {
        self.seconds = seconds
        self.microseconds = microseconds
    }
}

/// Free ports, found by asking the kernel rather than by guessing
/// (CODE_AGENT_SPEC §4.2, PV-15).
public enum PreviewPorts {
    /// Whether nothing listens on `port` on any interface, IPv4 or IPv6.
    public static func isFree(_ port: Int) -> Bool {
        guard (1...65_535).contains(port) else { return false }
        return canBind(port: port, family: AF_INET) && canBind(port: port, family: AF_INET6)
    }

    /// `preferred` when it is free, else the next free port above it (up to
    /// 50 tries), else one the kernel picks.
    public static func freePort(preferring preferred: Int? = nil) -> Int? {
        if let preferred, (1...65_535).contains(preferred) {
            for candidate in preferred..<min(preferred + 50, 65_536) where isFree(candidate) {
                return candidate
            }
        }
        for _ in 0..<20 {
            if let port = ephemeralPort(), isFree(port) { return port }
        }
        return nil
    }

    static func ephemeralPort() -> Int? {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return nil }
        defer { close(sock) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { return nil }
        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &actual) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(sock, $0, &length)
            }
        }
        guard named == 0 else { return nil }
        return Int(UInt16(bigEndian: actual.sin_port))
    }

    /// A wildcard bind without `SO_REUSEADDR`: it fails when anything holds
    /// the port on any address of that family.
    static func canBind(port: Int, family: Int32) -> Bool {
        let sock = socket(family, SOCK_STREAM, 0)
        guard sock >= 0 else { return family == AF_INET6 }
        defer { close(sock) }
        if family == AF_INET6 {
            var one: Int32 = 1
            setsockopt(sock, IPPROTO_IPV6, IPV6_V6ONLY, &one, socklen_t(MemoryLayout<Int32>.size))
            var addr = sockaddr_in6()
            addr.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            addr.sin6_family = sa_family_t(AF_INET6)
            addr.sin6_port = UInt16(port).bigEndian
            addr.sin6_addr = in6addr_any
            return withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) == 0
                }
            }
        }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = INADDR_ANY
        return withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
    }
}
