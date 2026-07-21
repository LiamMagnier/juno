-- Fresh native clients discover their hydration ids from EntityRevision.
-- Change capture started after production already contained account data, so
-- backfill every live sync entity at revision 0. The next trigger-observed
-- write increments it to revision 1, preserving optimistic-mutation semantics.

INSERT INTO "EntityRevision" ("id", "accountId", "entityType", "entityId", "revision", "deletedAt", "updatedAt")
SELECT 'rev_' || md5(u.id || ':profile:' || u.id), u.id, 'profile', u.id, 0, NULL, CURRENT_TIMESTAMP FROM "User" u WHERE true
ON CONFLICT ("accountId", "entityType", "entityId") DO NOTHING;

INSERT INTO "EntityRevision" ("id", "accountId", "entityType", "entityId", "revision", "deletedAt", "updatedAt")
SELECT 'rev_' || md5(s."userId" || ':settings:' || s.id), s."userId", 'settings', s.id, 0, NULL, CURRENT_TIMESTAMP FROM "Settings" s
UNION ALL SELECT 'rev_' || md5(s."userId" || ':subscription:' || s.id), s."userId", 'subscription', s.id, 0, NULL, CURRENT_TIMESTAMP FROM "Subscription" s
UNION ALL SELECT 'rev_' || md5(f."userId" || ':folder:' || f.id), f."userId", 'folder', f.id, 0, NULL, CURRENT_TIMESTAMP FROM "Folder" f
UNION ALL SELECT 'rev_' || md5(c."userId" || ':conversation:' || c.id), c."userId", 'conversation', c.id, 0, NULL, CURRENT_TIMESTAMP FROM "Conversation" c
UNION ALL SELECT 'rev_' || md5(a."userId" || ':attachment:' || a.id), a."userId", 'attachment', a.id, 0, NULL, CURRENT_TIMESTAMP FROM "Attachment" a
UNION ALL SELECT 'rev_' || md5(p."userId" || ':project:' || p.id), p."userId", 'project', p.id, 0, NULL, CURRENT_TIMESTAMP FROM "Project" p
UNION ALL SELECT 'rev_' || md5(m."userId" || ':memory:' || m.id), m."userId", 'memory', m.id, 0, NULL, CURRENT_TIMESTAMP FROM "MemoryEntry" m
UNION ALL SELECT 'rev_' || md5(p."userId" || ':saved_prompt:' || p.id), p."userId", 'saved_prompt', p.id, 0, NULL, CURRENT_TIMESTAMP FROM "SavedPrompt" p
UNION ALL SELECT 'rev_' || md5(c."userId" || ':connection:' || c.id), c."userId", 'connection', c.id, 0, NULL, CURRENT_TIMESTAMP FROM "Connection" c
UNION ALL SELECT 'rev_' || md5(u."userId" || ':usage:' || u.id), u."userId", 'usage', u.id, 0, NULL, CURRENT_TIMESTAMP FROM "Usage" u
UNION ALL SELECT 'rev_' || md5(s."userId" || ':share:' || s.id), s."userId", 'share', s.id, 0, NULL, CURRENT_TIMESTAMP FROM "Share" s
UNION ALL SELECT 'rev_' || md5(a."userId" || ':announcement_dismissal:' || a.id), a."userId", 'announcement_dismissal', a.id, 0, NULL, CURRENT_TIMESTAMP FROM "AnnouncementDismissal" a
UNION ALL SELECT 'rev_' || md5(t."userId" || ':scheduled_task:' || t.id), t."userId", 'scheduled_task', t.id, 0, NULL, CURRENT_TIMESTAMP FROM "ScheduledTask" t
UNION ALL SELECT 'rev_' || md5(d."userId" || ':code_device:' || d.id), d."userId", 'code_device', d.id, 0, NULL, CURRENT_TIMESTAMP FROM "CodeDevice" d
UNION ALL SELECT 'rev_' || md5(t."userId" || ':code_task:' || t.id), t."userId", 'code_task', t.id, 0, NULL, CURRENT_TIMESTAMP FROM "CodeTask" t
UNION ALL SELECT 'rev_' || md5(w."userId" || ':code_workspace:' || w.id), w."userId", 'code_workspace', w.id, 0, NULL, CURRENT_TIMESTAMP FROM "CodeWorkspace" w WHERE true
ON CONFLICT ("accountId", "entityType", "entityId") DO NOTHING;

INSERT INTO "EntityRevision" ("id", "accountId", "entityType", "entityId", "parentEntityId", "revision", "deletedAt", "updatedAt")
SELECT 'rev_' || md5(c."userId" || ':message:' || m.id), c."userId", 'message', m.id, m."conversationId", 0, NULL, CURRENT_TIMESTAMP
FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
UNION ALL
SELECT 'rev_' || md5(c."userId" || ':message_version:' || v.id), c."userId", 'message_version', v.id, v."messageId", 0, NULL, CURRENT_TIMESTAMP
FROM "MessageVersion" v JOIN "Message" m ON m.id = v."messageId" JOIN "Conversation" c ON c.id = m."conversationId"
UNION ALL
SELECT 'rev_' || md5(c."userId" || ':artifact:' || a.id), c."userId", 'artifact', a.id, a."conversationId", 0, NULL, CURRENT_TIMESTAMP
FROM "Artifact" a JOIN "Conversation" c ON c.id = a."conversationId"
UNION ALL
SELECT 'rev_' || md5(c."userId" || ':artifact_version:' || v.id), c."userId", 'artifact_version', v.id, v."artifactId", 0, NULL, CURRENT_TIMESTAMP
FROM "ArtifactVersion" v JOIN "Artifact" a ON a.id = v."artifactId" JOIN "Conversation" c ON c.id = a."conversationId"
UNION ALL
SELECT 'rev_' || md5(t."userId" || ':code_task_event:' || e.id), t."userId", 'code_task_event', e.id, e."taskId", 0, NULL, CURRENT_TIMESTAMP
FROM "CodeTaskEvent" e JOIN "CodeTask" t ON t.id = e."taskId" WHERE true
ON CONFLICT ("accountId", "entityType", "entityId") DO NOTHING;
