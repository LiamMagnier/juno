#if DEBUG
import Foundation

/// Canned Tasks and Connections payloads in the exact shapes `/api/tasks` and
/// `/api/connectors` serve, so both screens can be inspected without an account.
///
/// The fixtures cover the states worth looking at: an enabled schedule, a paused
/// one, a schedule whose last run failed, a connected app and an app this
/// deployment has not configured.
public enum PreviewWorkspaceExtras {
    public static let tasksJSON = """
    {"limit":10,"tasks":[
      {"id":"t1","name":"Morning research digest","prompt":"Summarise overnight arXiv papers.",
       "model":"anthropic:claude-sonnet-4-6","modelName":"Claude Sonnet 4.6","cadence":"WEEKDAYS",
       "hour":8,"minute":30,"weekday":null,"monthday":null,"timezone":"Europe/Paris",
       "webSearch":true,"enabled":true,"lastRunAt":"2026-07-22T06:30:00.000Z",
       "nextRunAt":"2026-07-23T06:30:00.000Z","conversationId":"c1",
       "createdAt":"2026-06-01T09:00:00.000Z",
       "latestRun":{"id":"r1","status":"succeeded","error":null,"costMicroUsd":1200,
                    "startedAt":"2026-07-22T06:30:00.000Z","finishedAt":"2026-07-22T06:30:44.000Z"}},
      {"id":"t2","name":"Weekly cost report","prompt":"Break down spend by model.",
       "model":"anthropic:claude-haiku-4-5","modelName":"Claude Haiku 4.5","cadence":"WEEKLY",
       "hour":18,"minute":0,"weekday":5,"monthday":null,"timezone":"Europe/Paris",
       "webSearch":false,"enabled":false,"lastRunAt":"2026-07-18T16:00:00.000Z",
       "nextRunAt":"2026-07-25T16:00:00.000Z","conversationId":null,
       "createdAt":"2026-05-02T09:00:00.000Z","latestRun":null},
      {"id":"t3","name":"Nightly backup check","prompt":"Confirm the backup completed.",
       "model":"anthropic:claude-haiku-4-5","modelName":"Claude Haiku 4.5","cadence":"DAILY",
       "hour":2,"minute":15,"weekday":null,"monthday":null,"timezone":"Europe/Paris",
       "webSearch":false,"enabled":true,"lastRunAt":"2026-07-23T00:15:00.000Z",
       "nextRunAt":"2026-07-24T00:15:00.000Z","conversationId":null,
       "createdAt":"2026-04-11T09:00:00.000Z",
       "latestRun":{"id":"r3","status":"failed","error":"The model returned no output.",
                    "costMicroUsd":0,"startedAt":"2026-07-23T00:15:00.000Z",
                    "finishedAt":"2026-07-23T00:15:09.000Z"}}
    ]}
    """

    public static let connectorsJSON = """
    {"composioConfigured":true,"connectors":[
      {"id":"google_calendar","kind":"oauth","label":"Google Calendar",
       "description":"Read your calendar.","capability":"Let Juno read your upcoming events.",
       "configured":true,"connected":true,"accountLabel":"liam@liams.dev",
       "connectedAt":"2026-06-18T10:00:00.000Z"},
      {"id":"gmail","kind":"oauth","label":"Gmail","description":"Read and draft mail.",
       "capability":"Let Juno search your mail and draft replies.",
       "configured":true,"connected":false,"accountLabel":null,"connectedAt":null},
      {"id":"notion","kind":"oauth","label":"Notion","description":"Read your pages.",
       "capability":"Let Juno read and update your Notion pages.",
       "configured":false,"connected":false,"accountLabel":null,"connectedAt":null}
    ]}
    """

    public static let composioCatalogJSON = """
    {"totalPages":1,"total":5,"categories":["productivity","developer"],"items":[
      {"id":"slack","slug":"slack","name":"Slack","logo":null,"connected":false,
       "connecting":false,"noAuth":false,"managedAuth":true,"status":null,"connectedAt":null},
      {"id":"linear","slug":"linear","name":"Linear","logo":null,"connected":false,
       "connecting":false,"noAuth":false,"managedAuth":true,"status":null,"connectedAt":null},
      {"id":"github","slug":"github","name":"GitHub","logo":null,"connected":false,
       "connecting":false,"noAuth":false,"managedAuth":true,"status":null,"connectedAt":null},
      {"id":"hackernews","slug":"hackernews","name":"Hacker News","logo":null,"connected":false,
       "connecting":false,"noAuth":true,"managedAuth":false,"status":null,"connectedAt":null},
      {"id":"asana","slug":"asana","name":"Asana","logo":null,"connected":false,
       "connecting":false,"noAuth":false,"managedAuth":false,"status":null,"connectedAt":null}
    ]}
    """
}
#endif
