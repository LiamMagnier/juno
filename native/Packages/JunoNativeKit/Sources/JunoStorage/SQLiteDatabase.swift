import Foundation
import SQLite3

final class SQLiteDatabase: @unchecked Sendable {
    private let url: URL
    private var handle: OpaquePointer?

    init(url: URL, schemaVersion: Int32) throws {
        self.url = url
        let manager = FileManager.default
        let directory = url.deletingLastPathComponent()
        var isDirectory: ObjCBool = false
        if !manager.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
            do {
                try manager.createDirectory(
                    at: directory,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700]
                )
            } catch {
                throw SQLiteAccountRepositoryError.fileProtectionFailed
            }
        } else if !isDirectory.boolValue {
            throw SQLiteAccountRepositoryError.invalidDatabaseURL
        }

        var opened: OpaquePointer?
        let code = sqlite3_open_v2(
            url.path,
            &opened,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
            nil
        )
        guard code == SQLITE_OK, let opened else {
            if let opened {
                sqlite3_close_v2(opened)
            }
            throw SQLiteAccountRepositoryError.openFailed(code: code)
        }
        handle = opened

        do {
            sqlite3_extended_result_codes(opened, 1)
            sqlite3_busy_timeout(opened, 5_000)
            try execute("PRAGMA foreign_keys = ON", operation: "enable foreign keys")
            try execute("PRAGMA trusted_schema = OFF", operation: "disable trusted schema")
            try migrate(to: schemaVersion)
            try verifySchema()
            try verifyIntegrity()
            try execute("PRAGMA secure_delete = ON", operation: "enable secure deletion")
            try execute("PRAGMA journal_mode = WAL", operation: "enable write-ahead log")
            try execute("PRAGMA synchronous = FULL", operation: "set durable commits")
            try protectFiles()
        } catch {
            sqlite3_close_v2(opened)
            handle = nil
            throw error
        }
    }

    deinit {
        if let handle {
            sqlite3_close_v2(handle)
        }
    }

    func close() throws {
        guard let handle else {
            return
        }
        let code = sqlite3_close_v2(handle)
        guard code == SQLITE_OK else {
            throw SQLiteAccountRepositoryError.statementFailed(
                operation: "close database",
                code: code
            )
        }
        self.handle = nil
    }

    func execute(_ sql: String, operation: String) throws {
        guard let handle else {
            throw SQLiteAccountRepositoryError.databaseClosed
        }
        let code = sqlite3_exec(handle, sql, nil, nil, nil)
        guard code == SQLITE_OK else {
            throw SQLiteAccountRepositoryError.statementFailed(
                operation: operation,
                code: sqlite3_extended_errcode(handle)
            )
        }
    }

    func withStatement<Result>(
        _ sql: String,
        operation: String,
        _ body: (OpaquePointer) throws -> Result
    ) throws -> Result {
        guard let handle else {
            throw SQLiteAccountRepositoryError.databaseClosed
        }
        var statement: OpaquePointer?
        let code = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard code == SQLITE_OK, let statement else {
            throw SQLiteAccountRepositoryError.statementFailed(
                operation: operation,
                code: sqlite3_extended_errcode(handle)
            )
        }
        defer { sqlite3_finalize(statement) }
        return try body(statement)
    }

    func step(_ statement: OpaquePointer, operation: String) throws -> Int32 {
        let code = sqlite3_step(statement)
        guard code == SQLITE_ROW || code == SQLITE_DONE else {
            throw SQLiteAccountRepositoryError.statementFailed(
                operation: operation,
                code: extendedErrorCode
            )
        }
        return code
    }

    func expectDone(_ statement: OpaquePointer, operation: String) throws {
        guard try step(statement, operation: operation) == SQLITE_DONE else {
            throw SQLiteAccountRepositoryError.statementFailed(
                operation: operation,
                code: SQLITE_MISUSE
            )
        }
    }

    func bind(
        _ value: String,
        at index: Int32,
        to statement: OpaquePointer
    ) throws {
        let code = sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
        try checkBind(code, operation: "bind text")
    }

    func bind(
        _ value: Int64,
        at index: Int32,
        to statement: OpaquePointer
    ) throws {
        try checkBind(
            sqlite3_bind_int64(statement, index, value),
            operation: "bind integer"
        )
    }

    func bind(
        _ value: Int32,
        at index: Int32,
        to statement: OpaquePointer
    ) throws {
        try checkBind(
            sqlite3_bind_int(statement, index, value),
            operation: "bind integer"
        )
    }

    func bind(
        _ value: Double,
        at index: Int32,
        to statement: OpaquePointer
    ) throws {
        try checkBind(
            sqlite3_bind_double(statement, index, value),
            operation: "bind real"
        )
    }

    func bind(
        _ value: Data?,
        at index: Int32,
        to statement: OpaquePointer
    ) throws {
        guard let value else {
            try checkBind(sqlite3_bind_null(statement, index), operation: "bind null")
            return
        }
        let code: Int32
        if value.isEmpty {
            code = sqlite3_bind_zeroblob(statement, index, 0)
        } else {
            code = value.withUnsafeBytes { bytes in
                sqlite3_bind_blob(
                    statement,
                    index,
                    bytes.baseAddress,
                    Int32(bytes.count),
                    sqliteTransient
                )
            }
        }
        try checkBind(code, operation: "bind data")
    }

    func text(
        _ statement: OpaquePointer,
        column: Int32,
        field: String
    ) throws -> String {
        guard sqlite3_column_type(statement, column) == SQLITE_TEXT,
            let value = sqlite3_column_text(statement, column)
        else {
            throw SQLiteAccountRepositoryError.corruptStoredValue(field: field)
        }
        return String(cString: value)
    }

    func data(
        _ statement: OpaquePointer,
        column: Int32,
        field: String
    ) throws -> Data {
        guard sqlite3_column_type(statement, column) == SQLITE_BLOB else {
            throw SQLiteAccountRepositoryError.corruptStoredValue(field: field)
        }
        let count = Int(sqlite3_column_bytes(statement, column))
        guard count > 0 else { return Data() }
        guard let bytes = sqlite3_column_blob(statement, column) else {
            throw SQLiteAccountRepositoryError.corruptStoredValue(field: field)
        }
        return Data(bytes: bytes, count: count)
    }

    func protectFiles() throws {
        let manager = FileManager.default
        for fileURL in [
            url,
            URL(fileURLWithPath: url.path + "-wal"),
            URL(fileURLWithPath: url.path + "-shm"),
        ] where manager.fileExists(atPath: fileURL.path) {
            do {
                var attributes: [FileAttributeKey: Any] = [
                    .posixPermissions: 0o600
                ]
                #if os(iOS)
                attributes[.protectionKey] =
                    FileProtectionType.completeUntilFirstUserAuthentication
                #endif
                try manager.setAttributes(attributes, ofItemAtPath: fileURL.path)
            } catch {
                throw SQLiteAccountRepositoryError.fileProtectionFailed
            }
        }
    }

    private var extendedErrorCode: Int32 {
        guard let handle else { return SQLITE_MISUSE }
        return sqlite3_extended_errcode(handle)
    }

    private func checkBind(_ code: Int32, operation: String) throws {
        guard code == SQLITE_OK else {
            throw SQLiteAccountRepositoryError.statementFailed(
                operation: operation,
                code: extendedErrorCode
            )
        }
    }

    private func migrate(to targetVersion: Int32) throws {
        let currentVersion = try userVersion()
        guard currentVersion <= targetVersion else {
            throw SQLiteAccountRepositoryError.unsupportedSchemaVersion(currentVersion)
        }
        guard currentVersion < targetVersion else { return }

        if currentVersion == 0, try containsUserTables() {
            throw SQLiteAccountRepositoryError.unexpectedUnversionedSchema
        }

        try execute("BEGIN EXCLUSIVE", operation: "begin migration")
        do {
            if currentVersion < 1 {
                try execute(Self.schemaV1, operation: "create schema version 1")
            }
            try execute(
                "PRAGMA user_version = \(targetVersion)",
                operation: "record schema version"
            )
            try execute("COMMIT", operation: "commit migration")
        } catch {
            try? execute("ROLLBACK", operation: "rollback migration")
            throw error
        }
    }

    private func userVersion() throws -> Int32 {
        try withStatement("PRAGMA user_version", operation: "read schema version") {
            statement in
            guard try step(statement, operation: "read schema version") == SQLITE_ROW else {
                throw SQLiteAccountRepositoryError.corruptStoredValue(
                    field: "schema version"
                )
            }
            return sqlite3_column_int(statement, 0)
        }
    }

    private func containsUserTables() throws -> Bool {
        try withStatement(
            """
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1
            """,
            operation: "inspect unversioned schema"
        ) { statement in
            try step(statement, operation: "inspect unversioned schema") == SQLITE_ROW
        }
    }

    private func verifyIntegrity() throws {
        try withStatement("PRAGMA quick_check", operation: "check database integrity") {
            statement in
            guard try step(statement, operation: "check database integrity") == SQLITE_ROW,
                try text(statement, column: 0, field: "integrity check") == "ok"
            else {
                throw SQLiteAccountRepositoryError.corruptStoredValue(
                    field: "database integrity"
                )
            }
        }
    }

    private func verifySchema() throws {
        try verifyTable(
            "accounts",
            expected: [
                SchemaColumn(name: "account_id", type: "TEXT", notNull: true, primaryKey: 1),
                SchemaColumn(name: "store_version", type: "INTEGER", notNull: true),
            ]
        )
        try verifyTable(
            "records",
            expected: [
                SchemaColumn(name: "account_id", type: "TEXT", notNull: true, primaryKey: 1),
                SchemaColumn(name: "namespace", type: "TEXT", notNull: true, primaryKey: 2),
                SchemaColumn(name: "record_id", type: "TEXT", notNull: true, primaryKey: 3),
                SchemaColumn(name: "revision", type: "INTEGER", notNull: true),
                SchemaColumn(name: "updated_at", type: "REAL", notNull: true),
                SchemaColumn(name: "is_tombstone", type: "INTEGER", notNull: true),
                SchemaColumn(name: "payload", type: "BLOB", notNull: false),
            ]
        )
        try verifyTable(
            "metadata",
            expected: [
                SchemaColumn(name: "account_id", type: "TEXT", notNull: true, primaryKey: 1),
                SchemaColumn(name: "metadata_key", type: "TEXT", notNull: true, primaryKey: 2),
                SchemaColumn(name: "value", type: "BLOB", notNull: true),
            ]
        )
        try verifyCascadeForeignKey(table: "records")
        try verifyCascadeForeignKey(table: "metadata")

        try withStatement(
            "PRAGMA foreign_key_check",
            operation: "verify foreign keys"
        ) { statement in
            guard try step(statement, operation: "verify foreign keys") == SQLITE_DONE else {
                throw SQLiteAccountRepositoryError.corruptStoredValue(
                    field: "foreign keys"
                )
            }
        }
    }

    private func verifyTable(
        _ table: String,
        expected: [SchemaColumn]
    ) throws {
        let operation = "verify \(table) schema"
        let actual = try withStatement(
            "PRAGMA table_info(\(table))",
            operation: operation
        ) { statement in
            var columns: [SchemaColumn] = []
            while try step(statement, operation: operation) == SQLITE_ROW {
                columns.append(
                    SchemaColumn(
                        name: try text(statement, column: 1, field: operation),
                        type: try text(statement, column: 2, field: operation),
                        notNull: sqlite3_column_int(statement, 3) == 1,
                        primaryKey: sqlite3_column_int(statement, 5)
                    )
                )
            }
            return columns
        }
        guard actual == expected else {
            throw SQLiteAccountRepositoryError.corruptStoredValue(field: operation)
        }
    }

    private func verifyCascadeForeignKey(table: String) throws {
        let operation = "verify \(table) foreign key"
        let valid = try withStatement(
            "PRAGMA foreign_key_list(\(table))",
            operation: operation
        ) { statement in
            guard try step(statement, operation: operation) == SQLITE_ROW else {
                return false
            }
            let targetTable = try text(statement, column: 2, field: operation)
            let sourceColumn = try text(statement, column: 3, field: operation)
            let targetColumn = try text(statement, column: 4, field: operation)
            let deleteAction = try text(statement, column: 6, field: operation)
            guard try step(statement, operation: operation) == SQLITE_DONE else {
                return false
            }
            return targetTable == "accounts"
                && sourceColumn == "account_id"
                && targetColumn == "account_id"
                && deleteAction == "CASCADE"
        }
        guard valid else {
            throw SQLiteAccountRepositoryError.corruptStoredValue(field: operation)
        }
    }

    private static let schemaV1 = """
        CREATE TABLE accounts (
            account_id TEXT PRIMARY KEY NOT NULL,
            store_version INTEGER NOT NULL CHECK(store_version >= 0)
        );
        CREATE TABLE records (
            account_id TEXT NOT NULL,
            namespace TEXT NOT NULL,
            record_id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision >= 0),
            updated_at REAL NOT NULL,
            is_tombstone INTEGER NOT NULL CHECK(is_tombstone IN (0, 1)),
            payload BLOB,
            PRIMARY KEY(account_id, namespace, record_id),
            FOREIGN KEY(account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
            CHECK(is_tombstone = 0 OR payload IS NULL)
        ) WITHOUT ROWID;
        CREATE TABLE metadata (
            account_id TEXT NOT NULL,
            metadata_key TEXT NOT NULL,
            value BLOB NOT NULL,
            PRIMARY KEY(account_id, metadata_key),
            FOREIGN KEY(account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        ) WITHOUT ROWID;
        """
}

private struct SchemaColumn: Equatable {
    let name: String
    let type: String
    let notNull: Bool
    let primaryKey: Int32

    init(
        name: String,
        type: String,
        notNull: Bool,
        primaryKey: Int32 = 0
    ) {
        self.name = name
        self.type = type
        self.notNull = notNull
        self.primaryKey = primaryKey
    }
}

private let sqliteTransient = unsafeBitCast(
    -1,
    to: sqlite3_destructor_type.self
)
