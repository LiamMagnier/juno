# Figma: file browser, sharing, permissions, comments and cross-device (how Figma organises the things people make)

Research date: 2026-09-23. Lens: the organisation and collaboration layer around made things in Figma, contrasted with Claude's merged artifact platform (16 Sept 2026) and with Juno today.

**How to read the confidence tags**
- **[P] primary:** a Figma-owned source. That means help.figma.com, the figma.com blog or release notes, a Figma staff post on forum.figma.com, or an App Store listing published by Figma. The evidence file for the Claude column is also primary.
- **[S] secondary:** press, aggregators, or blogs by other people.
- **[C] community:** user posts on the Figma forum, and App Store reviews.
- **[I] inferred:** my own reading or a recommendation.

**Caveats**
- Most help.figma.com articles show no publish or update date. For those, "n.d., accessed 2026-09-23" means the page was current on the research date.
- Page contents were pulled with WebFetch, which summarises pages. Exact UI labels are copied as returned, but a few may be paraphrased.
- The WebSearch budget ran out partway through. After that, only known URLs could be fetched. Section 16 lists the gaps this left.

Local evidence used:
- `docs/design/artifacts-design/research/claude-primary-evidence.md` (Claude, authoritative).
- `docs/design/artifacts-design/00-AUDIT-OVERVIEW.md` §4 and §12.7–12.8 (Juno).
- The installed Figma plugin skills (`figma-create-new-file/SKILL.md`, `figma-use/references/plugin-api-standalone.d.ts`).

---

## 0. The ten findings that matter most for Juno

1. **In August 2026 Figma rebuilt its content and permissions model.** "Projects" became **folders**, folders can nest up to 10 levels, and permissions became two states: **Inherited** or **Limited**. The share modal and admin controls were rewritten with it. [P] ([help: Updates to Figma's file management](https://help.figma.com/hc/en-us/articles/41753150926103-Updates-to-Figma-s-file-management), effective 2026-08-03; [blog: Code, craft, and the making of nested folders](https://www.figma.com/blog/code-craft-and-the-making-of-nested-folders/), 2026-08-03)
2. **Removing folder thumbnails caused an immediate backlash, and Figma put them back six weeks later.** The new folder tiles dropped previews of the files inside, and users said they could no longer find work at a glance. Previews returned on 2026-09-16, along with stronger folder colours and folder duplication. For any library of made things, visual previews are the main way people find things, not decoration. [P] staff reply and release notes, [C] thread ([forum: Figma folders](https://forum.figma.com/share-your-feedback-26/figma-folders-57057), 2026-08-18/19; [release notes](https://www.figma.com/release-notes/), 2026-09-16)
3. **Figma keeps "share" and "publish" apart.**
   - **Share** grants live access to people: view or edit, scoped to anyone, the organisation, a workspace, or invited people only.
   - **Publish** (Make and Sites) puts a pinned public build at `three-random-words.figma.site`. The owner must press **Update** to push changes, and the URL stays the same after unpublishing and republishing.
   - This is the two-concept model the Juno audit asks for (§12.7). [P] ([help: Publish, update, or unpublish a Figma Make file](https://help.figma.com/hc/en-us/articles/31304586129559-Publish-update-or-unpublish-a-Figma-Make-file))
4. **Figma's AI conversations became shared collaboration objects.**
   - Since **2026-06-23**, new chats with the Figma agent are **visible by default** to others on the file. Figma's two help pages disagree on who sees them. The chat-visibility article says "anyone with access to the file". The Config 2026 help page says people in the org or team "with a Full seat and edit access". (Fact-check correction: the audience is disputed, see the Fact-check section.)
   - Each chat can be switched between **Shared chat** and **Private chat**. **Copy link to chat** checks the recipient's access to the file.
   - Only the person who started a chat can continue it.
   - [P] ([help: Manage chat visibility for the Figma agent](https://help.figma.com/hc/en-us/articles/41272399602583); [forum: Everything announced at Config 2026](https://forum.figma.com/product-updates-3/everything-announced-at-config-2026-55221), 2026-06-24)
5. **Comments are well-developed but tied to the file.**
   - Pins or regions, attached to top-level frames so they move with them.
   - Threads, @mentions, emoji reactions, up to 5 images, and Markdown formatting.
   - Resolving hides a thread. Filters and **Shift+C** show or hide comments. Comments are rate-limited to **100 per hour**.
   - Deleting a comment is permanent and survives a version restore.
   - Comments on prototypes flow back into the design file, but commenting requires signing in. [P]
6. **Figma has no equivalent of Claude's "send this comment to Claude".**
   - From its chat, the agent can "review comments" and "summarize, sort, and take action on comments in the design file". [P, [help: agent](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files); blog, 2026-05-20] (Fact-check correction: this goes beyond summarising.)
   - None of the sources fetched show a comment being routed to the agent as a turn, an @mention of the agent, or the agent replying inside a comment thread. The agent reads comments from the chat side only.
   - Claude's bridge from comment to turn (the evidence file: comments "sent to Claude" arrive as turns, and Claude answers in the thread) is therefore a real point of difference. [I]
7. **Figma's mobile app is still for viewing, commenting and mirroring.**
   - You cannot edit Design files or Slides decks on mobile. FigJam is editable on iPad.
   - Make files open in preview only, and the agent is desktop and web only.
   - Claude's pitch of "one link, editable on your phone" goes beyond what Figma offers today. [P] ([help: Guide to the Figma mobile app](https://help.figma.com/hc/en-us/articles/1500007537281-Guide-to-the-Figma-mobile-app); [help: agent](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files))
8. **A seat and a permission are two separate gates, and users keep tripping over it.** You need the right seat type (Full, Dev, Collab or View) and "can edit" on the file. Having one without the other is the most common source of "I can't edit" posts. [P] help, [C] forum
9. **Governance is deep but mostly limited to higher plans.**
   - Public-link toggles (Organization plan).
   - Required passwords, auto-generated four-word passwords, and link expiry of 1 hour to 31 days (Enterprise).
   - Activity logs with CSV export and an API (Enterprise). A retention period of 365 days is stated nowhere in the help page or the API docs (unverified).
   - Governance+ adds export blocking, IP allowlists, guest expiry, a discovery pipeline that also captures AI prompts, and AI hosting controls. [P]
10. **Presence has been refined over years.**
    - Click someone's avatar to follow them. Their viewport is outlined in their colour.
    - **Spotlight** asks everyone to follow you, with a few seconds to press **Not now**.
    - Cursor chat (**/**) shows for 5 s and then fades. When someone speaks on audio, their avatar pops up in the toolbar and their cursor pulses with their voice.
    - Viewer history (February 2025) shows **Currently viewing** and **Previously viewed**. [P]
    - Note: the cursor-chat help page cited is written for FigJam.

---

## 1. Object model and hierarchy

### 1.1 Hierarchy (as of 2026-09) [P]
**Organization → Workspace** (Enterprise, optional) **→ Team → Folder** (nested to 10 levels) **→ File**. Each team also has a **Drafts** space per person. ([help: Guide to files and folders](https://help.figma.com/hc/en-us/articles/1500005554982-Guide-to-files-and-folders), n.d.)

**File types, each with its own extension** [P] (same source):

| Product | Extension |
|---|---|
| Figma Design | `.fig` |
| FigJam | `.jam` |
| Figma Slides | `.deck` |
| Figma Buzz | `.buzz` |
| Figma Sites | `.site` |
| Figma Make | `.make` |

- **Weave** lives outside the file browser as a separate product experience. [P] ([help: Create a new file](https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file))
- The plugin API's `editorType` is `'figma' | 'figjam' | 'dev' | 'slides' | 'buzz'`. [P] (local `plugin-api-standalone.d.ts` line 16)

**Plan limits** [P]:
- **Starter:** 1 folder; 3 files per product type per folder (3 Design + Sites files in total); unlimited drafts.
- **Paid plans:** unlimited files and folders.
- ([help: Guide to files and folders](https://help.figma.com/hc/en-us/articles/1500005554982-Guide-to-files-and-folders))

### 1.2 The August 2026 content and permissions redesign [P]
Source: [help: Updates to Figma's file management](https://help.figma.com/hc/en-us/articles/41753150926103-Updates-to-Figma-s-file-management). Effective 2026-08-03, rolled out over a few weeks to all plans.

**Renaming and nesting**
- "Projects" became "folders" everywhere: menus, the share modal, and the file browser. Old project links redirect.
- New folders can be given a colour.
- Folders nest up to 10 levels. Nested folders and their files inherit their parent's permissions.

**Permission model: three old settings collapsed into two**
- **Old:** "Same as team", "View only", "Disable".
- **New:**
  - **Inherited**: "Anyone in [Parent] can access".
  - **Limited**: "Only people added to [Resource] can access".
- What each plan can limit:
  - Organization and Enterprise can limit any folder.
  - Professional can limit top-level folders only.
  - Starter has one folder, which follows team access.
- People who had "View only" access were migrated to individual viewer entries. [P] The knock-on claim that share modals now list more people could not be found in either help page (unverified). ([help: File and folder permissions](https://help.figma.com/hc/en-us/articles/35361119554711-File-and-folder-permissions))

**Changes for Starter and Professional plans**
- Admins choose the seat type (Full, Collab, Dev or View) when inviting someone.
- New members no longer get access to folders automatically.
- There is now one admin role; the separate team owner role is gone.
- A **"Limited Access" badge** marks members who can reach only specific folders or files.

**Background from the blog** [P] ([blog](https://www.figma.com/blog/code-craft-and-the-making-of-nested-folders/), 2026-08-03, Ethan Adams, Cai Charniga, Sachi Shah)
- The team says the change required rethinking the content and permissions model from the ground up: file browser, admin, sharing and infrastructure.
- The hardest design problem was how the share modal should explain inheritance, especially when it is broken.
- The work was led by code prototypes and included an early-access programme recruited from Config 2026 attendees.
- The blog confirms that the share modal was reworked to explain inheritance. Folder colours are confirmed by the help article and the staff forum post, not by the blog. Breadcrumbs and drag-and-drop for folders are not mentioned in the blog, the help article or the staff announcement (unverified). (Fact-check correction: the earlier text credited all four to the blog.)
- A secondary write-up on AlternativeTo is dated 2026-08-04 [S] ([AlternativeTo](https://alternativeto.net/news/2026/8/figma-introduces-nested-folders-for-improved-file-organization-and-team-collaboration/)).

**Follow-up on 2026-09-16** [P] ([release notes](https://www.figma.com/release-notes/)): folders preview the files inside them again, folder colours are more distinct, and folders can be duplicated with their contents.

**What users said** [C] ([forum: rollout thread](https://forum.figma.com/product-updates-3/rolling-out-projects-become-folders-56675), from 2026-08-03; [forum: Figma folders](https://forum.figma.com/share-your-feedback-26/figma-folders-57057), 2026-08-18/19)
- Praise for nesting.
- Strong complaints about losing thumbnail previews, and colour-only differentiation is an accessibility problem.
- Sort order resets every time you come back to a folder.
- Requests for file counts on folders and for emoji or icons on folders.
- Figma staff (Tom Reem) replied in the thread announcing that previews were back.

### 1.3 Drafts: a cautionary migration [P]
Sources: [blog: Updates to how drafts work](https://www.figma.com/blog/updates-to-how-drafts-work/), 2024-06-03; [help: Updates to how drafts work](https://help.figma.com/hc/en-us/articles/18409526530967-Updates-to-how-drafts-work).

**Why Figma moved drafts into teams**
- Drafts used to float outside any team. Figma cited unclear ownership, no link to paid features (password protection, Dev Mode), and a risk of losing files.
- Drafts now belong to a team, with one private drafts space per person per team.

**How the migration ran**
- It ran from 2024-10-15 to 2025-10-09.
- A temporary **"Drafts to move"** space asked users to pick a team.
- On 2025-10-09 anything left there was moved automatically.
- Drafts in Organization and Enterprise plans cannot be moved freely between plans; the advice is to export a `.fig` file and import it. [S] ([AlternativeTo](https://alternativeto.net/news/2024/6/figma-is-relocating-where-your-drafts-live-for-users-on-a-starter-and-professional-team))

**Sharing limits in Drafts**
- Editors outside the team were converted to viewers so they would not create unexpected paid seats.
- On a **Starter** team, a file in Drafts shared with "Anyone" can only be viewed. To give edit access, move it into a folder. [P] (Fact-check correction: the help page scopes this to Starter-team drafts.) ([help: Share files and prototypes](https://help.figma.com/hc/en-us/articles/360040531773-Share-files-and-prototypes))

**What users said** [C] ([forum: I can't find my files](https://forum.figma.com/report-a-problem-6/i-cant-find-my-files-40147) and many "draft missing" threads)
- Many reports of drafts that "disappeared".
- Confusion when "Drafts to move" showed up on one device and not another.

---

## 2. File browser layout and navigation

Source: [help: Guide to the file browser](https://help.figma.com/hc/en-us/articles/14381406380183-Guide-to-the-file-browser), n.d. [P]

**Left sidebar, top to bottom:**
1. **Account menu**: profile, theme, settings, and switching between signed-in accounts.
2. **Search and the notifications bell.** Search covers files, folders and people across all teams. The bell covers mentions and invitations.
3. **Recents**: files you opened recently and things shared with you. Right-click → **Show in folder** jumps to where the file lives.
4. **Team or Organization**: an Enterprise dropdown switches between orgs and teams.
5. **Drafts**: includes a **Deleted files** tab with restore and duplicate.
6. **Browse / All folders**: everything you can reach in the team.
7. **Community**: templates, plugins and widgets.
8. **Starred**: your personal shortcuts.
9. **Trash**, kept separately per team or organisation.
10. **Admin**: people, seats, billing, settings.
11. **Custom sidebar sections** (Enterprise). ([help: Organize your sidebar with custom sections](https://help.figma.com/hc/en-us/articles/12399143113111-Organize-your-sidebar-with-custom-sections))

**Starred items** [P] ([help: Star your favorite files and folders](https://help.figma.com/hc/en-us/articles/360038511513-Star-your-favorite-files-and-folders))
- Four ways to star:
  - hover and click the star;
  - right-click → **Add to your favorites**;
  - drag the file into Starred;
  - in an open file, use the file-name menu → **Add to sidebar**.
- Starring is private to you and does not move the file. Starred items can be reordered by dragging.
- The labels are inconsistent: "Starred" in some places, "favorites" in others. [I]

**Pinned files** [P] ([help: Pin files to a folder](https://help.figma.com/hc/en-us/articles/360038511713-Pin-files-to-a-folder); workspace pinning also exists, [help](https://help.figma.com/hc/en-us/articles/24632833055767-Pin-files-to-a-workspace))
- Anyone who can edit a folder can right-click → **Pin to folder**.
- Pins show as square thumbnails at the top of the folder, labelled with who pinned them.
- The order cannot be changed.

**Search** [P] ([help: Search for files, folders, and people](https://help.figma.com/hc/en-us/articles/4422774037271-Search-for-files-folders-and-people))
- Shortcut: **⌘/** or **Ctrl+/**.
- Results appear in a live preview as you type, then on a full results page.
- **What it searches:** files, folders, teams, people, Community resources, private plugins, and the text inside Design and FigJam files.
- **Filters:**
  - resource type (Files, Folders, People, Teams, Private plugins, Widgets);
  - location (Enterprise org or workspace);
  - file type.
- **Sort:** Relevance, Name, Last modified, Created.
- Users have long asked for more filters. [C] ([forum](https://forum.figma.com/t/need-filters-when-searching-for-files/32129))

**Templates and resources** [P] ([help: Find and use templates and resources](https://help.figma.com/hc/en-us/articles/31668820539287-Find-and-use-templates-and-resources-from-your-team-or-organization))
- A **Resources** space per team or organisation.
- Templates can be published to the team or the whole organisation.
- On Professional plans, templates exist for Make, Buzz, FigJam and Slides.
- On 2026-08-17 Figma added **admin-recommended resources** for organisations and workspaces. [S] ([Releasebot aggregation of Figma release notes](https://releasebot.io/updates/figma))

**Community** [P] ([help: Duplicate Community files](https://help.figma.com/hc/en-us/articles/360038510873-Duplicate-Community-files); [help: Publish files to the Community](https://help.figma.com/hc/en-us/articles/360040035974))
- **Open in Figma** or **Open in FigJam** copies the file into your Drafts, with "(Community)" added to the name.
- The copy gets no updates, no history and no comments from the original.
- Slide templates use **Use template**.
- To publish, go to Share → **Publish to Community**.

**File thumbnails** [P] ([help: Set custom thumbnails for files](https://help.figma.com/hc/en-us/articles/360038511413-Set-custom-thumbnails-for-files))
- The default is generated from the first page.
- To set your own, right-click a frame → **Set as thumbnail**; the frame then shows a thumbnail indicator. **Restore default thumbnail** reverts.
- Recommended size is 1920×1080 (16:9).
- Anyone who can edit may change it. In FigJam, a section can be the thumbnail.

---

## 3. How a file gets made

- **+ Create** in the top-right of the file browser opens a dropdown: Design, FigJam, Slides, Sites, Make and Buzz. [P] ([help: Create a new file](https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file))
- **Quick URLs:** `figma.new`, `figjam.new`, `flides.new`, `buzz.new`. [P] (same source)
- **Where new files land:** in Drafts, or in the folder you are viewing. After creation you can start blank or pick a template (FigJam, Slides, Buzz). [P]
- **Duplicating:** right-click → **Duplicate**, or the file-name menu (**Duplicate to drafts** if you can only view), or add `/duplicate` to the URL.
  - The copy is named "Copy of …" and has no comments or version history.
  - People with view access get their copy in Drafts; editors get it next to the original.
  - [P] ([help: Duplicate or copy files](https://help.figma.com/hc/en-us/articles/360038511533-Duplicate-or-copy-files))
- **Files made by an agent** go by default to the user's **Drafts** for a chosen plan.
  - The MCP `create_new_file` tool needs a `planKey` (format `team::<id>` or `organization::<id>`), which comes from `whoami`. If the user belongs to several plans, the agent must ask which one.
  - The live tool schema also accepts an optional `projectId` (a folder id taken from a `figma.com/files/.../project/:id` URL), which places the file inside that folder instead of Drafts. The installed skill mentions only Drafts. (Fact-check addition.)
  - Supported types are design, figjam and slides.
  - Placement is therefore explicit: Figma never creates an orphan file. [P] (local `figma-create-new-file/SKILL.md`; the `create_new_file` tool schema of the connected Figma MCP server, read 2026-09-23)

---

## 4. The Share modal

Sources: [help: Share files and prototypes](https://help.figma.com/hc/en-us/articles/360040531773-Share-files-and-prototypes); [help: Guide to sharing and permissions](https://help.figma.com/hc/en-us/articles/1500007609322-Guide-to-sharing-and-permissions); [help: File and folder permissions](https://help.figma.com/hc/en-us/articles/35361119554711-File-and-folder-permissions). All n.d. [P]

### 4.1 What's in it
The **Share** button sits at the top right of the editor. The modal contains, in order:

1. **Invite field**: emails, or user groups on Organization and Enterprise plans.
2. **Audience dropdown**: **Anyone** / **[Organization]** / **[Workspace]** (Enterprise) / **Only invited people**.
3. **Access level for that audience**: **can view** or **can edit**.
4. **Who has access**, grouped in this order: plan or workspace access, then inherited access from the parent team or folder, then individuals, then user groups.
5. **More ways to share**:
   - Copy Dev Mode link.
   - Copy prototype link (Design only).
   - Publish to Community.
   - Get embed code (Design only).
   - Publish as template (FigJam).
   - Open session (FigJam).
6. **Copy link**. If a frame is selected, the link points to that frame.

### 4.2 Settings that need a paid plan [P]
- **Password protect** the file.
- **Organization search visibility**.
- **Set an expiration on public links** (Enterprise).
- **Allow viewers to copy, share, and export**. Viewers also need this setting before they can create a branch.

### 4.3 Roles and gates [P]
- **Permission roles:** Owner, can edit, can view. Viewers can inspect, follow others and comment.
- **Seats are a separate gate:** Full, Dev, Collab (FigJam and Slides) or View. A person with a View seat cannot edit even if the file says "can edit". ([help: Guide to sharing and permissions](https://help.figma.com/hc/en-us/articles/1500007609322-Guide-to-sharing-and-permissions))
- **Asking for more access:**
  - A viewer in a team file clicks **Ask to edit** in the toolbar.
  - Owners get an email and an in-app notification, and a **red badge appears on the Share button**. They approve or deny from inside the modal.
  - Seat upgrades go to admins as a separate request.
  - ([help: Request to edit a file](https://help.figma.com/hc/en-us/articles/4408435431319-Request-to-edit-a-file))

### 4.4 Sharing only the prototype [P / C]
- A **prototype-only link** (paid plans) comes from presentation view → **Share prototype**, not from the editor's Share button. ([help](https://help.figma.com/hc/en-us/articles/360040531773-Share-files-and-prototypes))
- On Starter, prototype viewers can reach the source file through **Open in editor**. (same source)
- **What users say:** there are recurring complaints that a prototype link exposed the working file, and that the old "can view prototypes only" role disappeared. Staff advice is to set the file to Only invited people, untick the copy/share/export setting, and invite people to the prototype. [C] ([forum: prototype-only link](https://forum.figma.com/ask-the-community-7/prototype-only-link-prevent-client-access-to-working-files-30630); [forum: what happened to can view prototypes only](https://forum.figma.com/ask-the-community-7/what-happened-to-the-can-view-prototypes-only-permission-2787))

### 4.5 Embeds [P]
Source: [help: Embed files and prototypes](https://help.figma.com/hc/en-us/articles/360039827134-Embed-files-and-prototypes).
- Share → **Get embed code**.
- An embed follows the file's share settings:
  - a public file works for anyone;
  - an org-only file requires sign-in;
  - a password-protected file cannot be embedded.
- Works in web tools such as Notion, Confluence, Jira, Coda, Storybook and zeroheight.
- **Embed Kit 2.0** exists for programmatic embedding. (Its details were not fetched.)

### 4.6 Working with other organisations [P]
Source: [help: Guide to connected folders](https://help.figma.com/hc/en-us/articles/30124855491863-Guide-to-connected-folders).
- **Connected folders** (launched H1 2025 as "connected projects") let an agency and a client share one folder. [S] ([AlternativeTo](https://alternativeto.net/news/2025/4/figma-adds-connected-projects-enhanced-collaboration-for-freelancers-and-agencies))
- Each person uses a seat from their own plan.
- **Setup:** the host creates the connection; an admin on the other side approves it.
- **Limits:** Professional 3, Organization 6, Enterprise 15.
- **On disconnect,** the host keeps the files and can share a copy or transfer ownership.

---

## 5. Publishing to the web (Make and Sites), kept separate from sharing [P]

Sources: [help: Publish, update, or unpublish a Figma Make file](https://help.figma.com/hc/en-us/articles/31304586129559-Publish-update-or-unpublish-a-Figma-Make-file); [help: Publish, update, or unpublish a site](https://help.figma.com/hc/en-us/articles/31242845959703-Publish-update-or-unpublish-a-site); [help: Manage web publishing for an organization](https://help.figma.com/hc/en-us/articles/31242876956183-Manage-web-publishing-for-an-organization).

**Publish flow:** **Publish** (top right) opens a modal with:
- title;
- URL, generated as `three-random-words.figma.site`;
- status (**Not published** or **Published**);
- a warning if web fonts are missing;
- **Who can view**, on Organization and Enterprise: **Anyone on the web** or organisation members only.

**Updating and unpublishing**
- Edits do not go live on their own. You press **Update**, and the URL stays the same.
- **Unpublish** takes the site down; republishing later reuses the same URL.

**Passwords and domains**
- A password can be custom (at least 4 characters) or generated by Figma as four random words. It cannot be combined with organisation-only access ("You can't add a password if the audience is set to internal-only").
- Sites and Make can take a custom domain, and the two products share one per-plan domain limit. The earlier claims of per-page passwords on Sites and of "Professional 10, higher plans unlimited" were not found on the Make or Sites publishing pages (unverified).
- Sites also keep a **publish history**, so you can revert the live site to an earlier published version without changing the canvas. The figma.site subdomain cannot be changed. [P] ([help: Publish a site](https://help.figma.com/hc/en-us/articles/31242845959703-Publish-update-or-unpublish-a-site)) (Fact-check addition.)

**Admin controls**
- Admins can turn off public web publishing. Publishing inside the organisation cannot be turned off.
- Enterprise can require a password on everything published, require generated passwords, and override these settings per workspace.

**Takeaway for Juno [I]:** Figma shows the owner a clear state (Not published / Published) and a separate Update step. Juno's share dialog today publishes as soon as it opens and resolves snapshots by timestamp (audit §12.7).

---

## 6. Comments

### 6.1 Creating a comment [P]
Source: [help: Add comments to files](https://help.figma.com/hc/en-us/articles/360041068574-Add-comments-to-files).
- **C** or the toolbar button enters comment mode. The cursor becomes a comment cursor and you cannot edit objects until you press Esc or pick another tool.
- **Click** to drop a pin, or **click and drag** to comment on a region.
- **What a pin attaches to:** a comment attaches to the **top-level frame, component or group** under it and moves when that frame moves. It does **not** attach to nested layers. A long-running feature request asks for this. [C] ([forum](https://forum.figma.com/suggest-a-feature-11/keep-comments-pinned-to-design-elements-including-nested-17753))
- **Composer:**
  - @mentions (including "All team members");
  - an emoji picker;
  - **up to 5 images or GIFs** (PNG, JPEG or GIF; drag or paste);
  - bold, italic, strikethrough, links and lists, by shortcut or Markdown.
- **Rate limit:** **100 comments per hour**, replies included.
- Anyone with at least view access can comment. [P] ([help: Guide to comments](https://help.figma.com/hc/en-us/articles/360039825314-Guide-to-comments-in-Figma))

### 6.2 Managing comments [P]
Sources: [help: View and manage comments](https://help.figma.com/hc/en-us/articles/360041547593-View-and-manage-comments); [help: Move or edit comments](https://help.figma.com/hc/en-us/articles/360041547853-Move-or-edit-comments).
- **Right sidebar list:** clicking a comment jumps to its page and position.
- **List options:**
  - **Sort by date** (default);
  - **Sort by unread**;
  - **Show resolved comments** (toggle);
  - **Only your threads** (threads you started, were mentioned in, or replied to);
  - **Only current page**.
- **Actions:**
  - hover a comment to react;
  - the menu offers **Mark as unread**, **Copy link to the comment**, and **Delete the thread** (author only).
  - The **Resolve** button hides the thread from both the canvas and the list.
  - Drag a pin to move it.
- **Deletion is permanent.** Restoring an earlier version of the file does not bring a deleted comment back.
- **Shift+C** shows or hides all comments on the canvas.
- **In FigJam,** a comment on a shape or sticky attaches to that object. [P] ([help: Comments in FigJam](https://help.figma.com/hc/en-us/articles/1500004290941-Comments-in-FigJam))

### 6.3 Comments on prototypes and Make [P]
- **Prototypes:** press C in presentation view.
  - Comments show up in the design file.
  - You must be **signed in** with at least view access, so anonymous viewers of a public link cannot comment.
  - Works on mobile.
  - ([help: Comment on prototypes](https://help.figma.com/hc/en-us/articles/360039824594-Comment-on-prototypes))
- **Figma Make:**
  - You can comment from the editor or from a full-screen preview, but not on the published site.
  - When you place a comment, Figma captures a screenshot of the element's state at that moment. This preserves context as the generated app changes.
  - The sidebar groups comments into **Current version** and **Other versions**.
  - Threads resolve with **Mark as resolved**.
  - ([help: Add comments in Figma Make](https://help.figma.com/hc/en-us/articles/38701587731735-Add-comments-in-Figma-Make))
  - **Takeaway [I]:** comments on AI-generated output need to be tied to a version.

### 6.4 Comment notifications [P]
Sources: [help: comment email notifications](https://help.figma.com/hc/en-us/articles/360041547813-Manage-email-notifications-for-comments-on-files); [help: Manage your notification preferences](https://help.figma.com/hc/en-us/articles/360039813234-Manage-your-notification-preferences); [help: Slack](https://help.figma.com/hc/en-us/articles/360039829154-Get-Figma-notifications-in-Slack).
- **Per-file setting** (comment mode → **Settings**): **Everything** / **Just mentions and replies** / **Nothing**. @mentions still notify you even on Nothing.
- **Defaults:** the file owner gets every comment. Anyone who has commented twice or more gets later comments.
- **Batching:** comment emails are grouped every **30 minutes**.
- **In-app bell:**
  - holds the **50 most recent** notifications;
  - you can reply to a comment directly from the list, accept or decline invites, and **mark all as read**;
  - in-app notifications cannot be turned off.
- **Other channels:** desktop notifications (Mac menu bar); push for browser, desktop and mobile; Slack. Microsoft Teams is documented for Dev Mode status notifications but is not listed for comment notifications on the preferences page (unverified for comments).
- **Access changes:** if a file goes from "Anyone" to invite-only, people who were never invited stop receiving its notifications.

### 6.5 Comments compared with the agent [P / I]
- The Figma agent can help "summarize feedback, identify themes, and turn input into next steps", and "distill" a long comment thread into an action plan. [P] ([blog: The Figma agent is here](https://www.figma.com/blog/the-figma-agent-is-here/), 2026-05-20)
- The agent help page goes further. It lists "Review comments" and "Summarize, sort, and take action on comments in the design file" as supported. [P] ([help: agent](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files)) So the agent can act on comments when asked from its chat.
- None of the fetched sources show @mentioning the agent in a comment, a comment being turned into an agent turn, or the agent replying inside a comment thread. Treat this as **not evidenced** rather than absent.
- Claude's model does this explicitly: a comment is sent to Claude, arrives as a turn, and Claude replies in the thread (evidence file).

---

## 7. Agent chats as shared objects in the file (2026)

Sources: [help: Work with the Figma agent in design files](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files); [help: Manage chat visibility](https://help.figma.com/hc/en-us/articles/41272399602583); [help: What's new from Config 2026](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026). All [P].

**Where it lives and how you start it**
- **Agents** in the **left navigation** lists all chats in the file, newest first, with a preview of the last message. It has **New chat** and **Back** controls.
- For a prompt on the canvas, select a layer and press **⌘/Ctrl+Enter**.
- From 2026-08-26 the desktop app offers **Pop out Agents panel** into a separate window. [P] ([release notes](https://www.figma.com/release-notes/))

**Progress and undo**
- Each running prompt shows an animated loading indicator on the canvas. Clicking it opens that chat.
- **Undo** in the chat, or ⌘Z, reverts the agent's most recent change.

**Who can see a chat**
- **From 2026-06-23,** new chats are **visible by default**. Older chats stay private. Figma's primary sources disagree on the audience:
  - the chat-visibility article says "visible by default to anyone with access to the file", and "Anyone with access to the file can view shared chats";
  - the Config 2026 help page says "visible by default to people within their organization or team with a Full seat and edit access to the file".
  - (Fact-check correction: the earlier text gave only the Full-seat-and-edit version. Full seat plus edit access is certainly what you need to have the agent *make edits*.)
- Switch visibility from the chat header → **More options** → **Shared chat** / **Private chat**. **Make your existing chats private** does it in bulk.
- **Copy link to chat** checks both file access and chat permission. Private chats cannot be linked.
- **Only the creator can continue a chat;** everyone else can only read it.
- Visibility applies to the whole conversation, not individual messages.
- The chat-visibility article lists Professional, Organization and Enterprise plans. The agent help page says "Available on all plans", and Config 2026 says all plans during the beta. The 2026-05-20 launch blog had said Full seats on paid plans only.
- On every seat and plan: Full seat plus edit access can have the agent make edits. View, Dev and Collab seats, and view-only users, can chat but not edit. The agent is free during the beta and will start using AI credits at GA ([AI credit updates FAQ](https://help.figma.com/hc/en-us/articles/42614902212887-AI-credit-updates-FAQ)).

**Where it isn't available**
- Desktop app and web only. The agent is not on mobile.
- At Config 2026 (2026-06-24) the agent was announced as coming to FigJam and Slides.

**What this means for Juno [I]:** Figma treats the conversation that produced a design as provenance collaborators can open. Juno could do the same for the conversation that made an artifact. Claude does it by making the artifact a thing that lives in a conversation.

---

## 8. Presence, following and awareness

**Following someone** (observation mode) [P]
- Click a collaborator's avatar to follow their view. Their viewport is outlined in their colour.
- Anyone with view access can follow.
- [P] ([blog: Observation mode](https://www.figma.com/blog/figma-feature-highlight-observation-mode/), 2018-08-02)

**Spotlight** [P] ([help: Present to collaborators using spotlight](https://help.figma.com/hc/en-us/articles/360040322673-Present-to-collaborators-using-spotlight); [help: Facilitate meetings with spotlight](https://help.figma.com/hc/en-us/articles/5025214483351-Facilitate-meetings-with-spotlight))
- **Start it:** hover your avatar → **Multiplayer tools** → **Spotlight me**.
- **What others see:** a notice with a few seconds to press **Not now** before their view switches to yours. Followers then see a coloured border around their canvas and a message at the top saying who they are following.
- **What the presenter sees:** their own avatar gets a dashed border, and the toolbar shows how many people are following.
- **Ending it:** **Stop following** at the top.
- **Requesting it:** **Ask to spotlight** on someone else's avatar.
- Works for viewers, and in presentation view.

**Cursors** [P]
- **View → Multiplayer cursors** turns them on or off.
- Following someone is silent to them, but your cursor stays visible to them.

**Cursor chat** [P] ([help: Send messages with cursor chat](https://help.figma.com/hc/en-us/articles/1500004414842-Send-messages-with-cursor-chat)). Note: the cited article is written for **FigJam** only ("in your FigJam file"). Whether the same behaviour applies in Figma Design was not verified.
- Press **/** with nothing selected.
- The message stays for **5 s** after you stop typing, then fades. After a while of inactivity it closes and returns you to the select tool.
- Nothing is logged.
- Viewers can use it.

**Audio** [P] ([help: Use audio to chat with your team](https://help.figma.com/hc/en-us/articles/1500004414622-Use-audio-to-chat-with-your-team); [blog](https://www.figma.com/blog/talk-it-out-in-figma-and-figjam/), 2021-08-31)
- **Start conversation** / **Join conversation**.
- When someone speaks, their avatar pops up in the toolbar and their cursor pulses in time with their voice.
- A green **Connected** label shows you have joined.
- Not available on mobile. Admins can turn it off.

**Viewer history** [P] ([help: See viewer history](https://help.figma.com/hc/en-us/articles/29638316371479-See-viewer-history-for-your-files); launched February 2025 per the help page; the exact day, 24 February, is unverified)
- Click the avatars in the right sidebar to see **Currently viewing** and **Previously viewed**, with time since each person's last visit.
- Only signed-in team or org members and invited guests are recorded. Public-link visitors are not.
- Individuals can opt out under account Settings → **View history** → **Change preference**.
- Paid plans only.

**How edits sync** [P] ([blog: How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/), 2019-10-16)
- If two people change the same property, the last change to reach the server wins.
- Your own edits apply locally straight away. To avoid flicker, incoming server changes that conflict with your unconfirmed edits are dropped.
- After being offline, the client downloads a fresh copy and replays your offline edits on top of it.

---

## 9. Handing designs to developers and review workflows

### 9.1 Dev Mode statuses [P]
Sources: [help: Dev Mode statuses and notifications](https://help.figma.com/hc/en-us/articles/26781702258583-Dev-Mode-statuses-and-notifications); [help: Ready for dev view](https://help.figma.com/hc/en-us/articles/23918228264855-Dev-Mode-ready-for-dev-view).

**The statuses**
- **Ready for dev** (all paid plans).
- **Completed** (Organization and Enterprise).
- Both get a **Changed** flag automatically when the design is edited afterwards. Library instance updates, variable or style value changes, and temporary states do **not** set the flag.

**Where the control is**
- On a section or frame: **Mark as ready for dev**, next to its label.
- On a component: at its top-right corner.

**Notes when the design changes**
- When clearing a Changed flag you can add a reason. The note goes into version history and triggers a notification.

**Who gets notified and how**
- Full and Dev seat holders who have opened the file in Dev Mode.
- By email, desktop, mobile push, Slack or Teams.
- Changes within **one hour** are grouped into one notification, with an **Inspect in Dev Mode** button.

**The ready for dev view**
- Opened from the **left sidebar**.
- Filter: **All** / **Ready** / **Completed**.
- Sort: **Recent activity** / **Pages** / **Name**.
- Clicking a design opens it in **focus view**.

### 9.2 Branching [P]
Sources: [help: Guide to branching](https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching); [help: Request a branch review](https://help.figma.com/hc/en-us/articles/5691414603543-Request-a-branch-review).
- Organization and Enterprise plans, Full seat.
- **Create:** file-name menu → **Create branch…**. The branch URL contains `/branch/<id>`.
- **Pulling from main:** when main changes you are notified and can pull everything in; you cannot pick individual changes.
- **Asking for review:** **Review and merge changes…** → pick reviewers → add a description → **Send to reviewers**.
- **Reviewing:**
  - Reviewers compare **side-by-side** or as an **overlay**, page by page.
  - They choose **Approve**, **Approve and merge**, or **Suggest changes**.
  - Conflicts are resolved before merging.
- **Managing branches:** the Branches dialog has **Active**, **Archived** and **Yours** tabs.
- **Access:** anyone invited to a branch also gets access to the main file.

### 9.3 Approvals in Figma Buzz [P]
Source: [help: Use approvals in Figma Buzz](https://help.figma.com/hc/en-us/articles/39288847137815-Use-approvals-in-Figma-Buzz). Organization and Enterprise; Figma Buzz itself is labelled Beta. Admins turn it on under Admin → Settings → Resources → Asset approvals, as either required or optional.
- **Request:** **Reviews** → **+ New Review** → choose assets and reviewers → **Send for review**.
- **Review:** reviewers step through each asset, then click **Mark as complete**.
- **Badges:** **In review**, **Approved**, **Changes needed**. "Complete" is the reviewer's final action, not a badge. (Fact-check correction.)
- **When approvals are required,** unapproved assets cannot be exported.
- **Locking:** approved assets are **locked** until someone clicks **Edit asset**, which removes the approval.
- **Takeaway [I]:** this approve-then-lock model is a good fit for marketing assets Juno generates.

---

## 10. Version history [P]

Sources: [help: View a file's version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history); [blog: Name and annotate version history](https://www.figma.com/blog/now-you-can-name-and-annotate-your-figma-version-history/).

**Opening it**
- File-name menu → **Show version history**. No shortcut opens the panel. **⌥⌘S** / **Ctrl+Alt+S** saves a new version to history. (Fact-check correction.)
- It opens in the right sidebar as a timeline back to when the file was created.

**Automatic checkpoints**
- Every **30 minutes**, plus when you lose connection or the app crashes.
- Automatic checkpoints between two named versions collapse under a date and can be expanded.

**Named versions**
- **Save to version history** takes a title (about 25 characters before it is cut off) and a description (under 140 characters recommended).
- **Name this version** can be applied to an older automatic checkpoint.

**Actions on a version**
- **Duplicate** creates a new file from that version.
- **Copy link** (the recipient needs edit access).
- **Restore** adds two checkpoints, one saving the state you are leaving and one for the restored state, so nothing is lost.
- **Delete version info** removes the name and description.

**Browsing an old version**
- It is read-only. You can pan, copy assets and export.

**Limits and permissions**
- **Starter** plans and **Drafts** see only 30 days of history.
- Viewers can look at versions. Only editors can name or restore them.

---

## 11. Figma on phones and tablets

Sources: [help: Guide to the Figma mobile app](https://help.figma.com/hc/en-us/articles/1500007537281-Guide-to-the-Figma-mobile-app) [P]; [App Store listing](https://apps.apple.com/us/app/figma/id1152747299) [P and C]; the Play Store listing is titled "Figma: view. comment. mirror." ([Play](https://play.google.com/store/apps/details?id=com.figma.mirror&hl=en_US)).

**Tabs:** **Recents**, **Search** (includes starred items), **Activity** (comment notifications), **Mirror**, and **Settings** (top-right icon).

**What you can do with each file type**

| File type | On mobile |
|---|---|
| Figma Design | View only |
| Prototypes | View only |
| Figma Slides | View only |
| Figma Make | Preview only |
| FigJam | Editable on **iPad** (sketching, Apple Pencil) |

- Figma states plainly that Design files and Slides decks cannot be edited in the mobile app.

**Viewing and interacting**
- Pan and pinch-zoom.
- Slides are navigated by thumbnails.
- Prototypes play full-screen with gestures, scaling and hotspot hints.

**Commenting**
- **Long-press** the canvas to comment.
- **Quick reply** to a comment without loading the whole file.
- Long-press a comment to react.

**Mirror**
- Select frames on desktop and see them live on the phone, including edits as they happen.

**Other**
- Push notifications are on by default.
- Requires iOS 16+ or Android 8+.
- The App Store listing also advertises managing permissions and browsing workspaces.

**App Store snapshot on 2026-09-23** [P and C]
- Version 26.36.0, released the day before; rating 4.6 from about 21K reviews.
- Complaints: Mirror disconnecting and freezing; rendering differences (shadows); users wanting to edit on iPad; screenshots that suggest editing is possible.
- **Figma for Government** has a separate iOS app (id6756397299).

**The agent is not available on mobile.** [P] ([help: agent](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files))

---

## 12. Working offline [P]

Source: [help: What can I do offline in Figma?](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma), n.d.

**What works offline**
- Create one new file.
- Edit pages of open files that were already loaded while you were online.
- Basic layer editing and local components.
- Play prototypes that were already loaded.
- Plugins that were already open and need no network.
- **Save a local .fig copy.**

**What does not work offline**
- Opening files that weren't already open.
- Pages that weren't loaded.
- Libraries.
- Version history.
- Presence (cursors, following).
- Installing plugins.

**How offline edits are stored and synced**
- Edits are kept in the browser's **IndexedDB** for **30 days** (7 days in Safari).
- When you reconnect:
  - a **blue notification** appears at the bottom of the screen;
  - affected files show an **unsynced changes icon**;
  - **Open to sync** reloads the file and applies your edits.
- If someone else changed the same things, a notification offers **Review** (opens version history) or **Dismiss**.
- The desktop app asks before you close with unsynced edits.

---

## 13. Admin and governance [P]

**Public links** [P] ([help: Manage public link sharing and open sessions](https://help.figma.com/hc/en-us/articles/5726756336791-Manage-public-link-sharing-and-open-sessions))
- **Organization plan:** turn public links off, which removes "Anyone" from the share modal. Turn FigJam **open sessions** off (open sessions end automatically after 24 h).
- **Enterprise:**
  - **Require passwords**, which removes "Anyone with the link".
  - **Autogenerated passwords only** (four random words).
  - **Link expirations** between 1 hour and 31 days. This turns off public links in FigJam.
  - Per-workspace overrides, which don't apply to drafts.
- Every change to these settings, and to any file's link settings, is recorded in the activity log.

**Content from outside the organisation** [P] ([help: Restrict access to content from outside your organization](https://help.figma.com/hc/en-us/articles/12080587805719-Restrict-access-to-content-from-outside-your-organization); [help: Restrict or prevent guest access](https://help.figma.com/hc/en-us/articles/4410793238167-Restrict-or-prevent-guest-access))
- Admin → Settings → Content → Access to external content.
- Guest controls.

**Activity logs** [P] ([help: View and export activity logs](https://help.figma.com/hc/en-us/articles/360040449533-View-and-export-activity-logs))
- Organization and Enterprise plans; organisation admins only.
- Logging **begins at the upgrade** to Organization or Enterprise and is not applied retroactively. A retention of 365 days is not stated on the help page or in the Activity Logs API docs (unverified).
- **Events logged:**
  - created, duplicated, exported, **viewed**, trashed, restored, permanently deleted;
  - changes to links, passwords and expiry;
  - permission changes;
  - team and organisation settings;
  - SCIM, seat changes;
  - branches, sites, folders, **AI features**, integrations, webhooks, SSO.
- **Each entry shows** the member, time (UTC), product, team and **IP address**.
- Filter by member, date, event or team. **CSV export** is emailed. Enterprise has an **Activity Logs API**.

**Governance+ (Enterprise add-on)** [P] ([help: Governance+ for Figma](https://help.figma.com/hc/en-us/articles/31825370509591-Governance-for-Figma))
- Restrict file exporting (**Prevent exporting for all viewers**).
- Network access restrictions; IP allowlist.
- **Discovery pipeline**: logs text edits in comments, shapes and so on, **plus AI prompts**, kept for 30 days.
- Idle session timeout as short as 15 min.
- Require 2FA for guests; multiple identity providers; internal policies that users must accept.
- **Enterprise Key Management** (AWS KMS).
- **Guest access expiration.**
- **AI hosting controls** (route AI traffic only to Figma's AWS).
- **Developer Logs API** for REST and MCP calls.
- Control over what Figma support staff can see.

**Web publishing controls:** see §5.

**Admin changes in 2026** [S] (Releasebot aggregation of Figma release notes; [release notes](https://www.figma.com/release-notes/) [P] for 08-24)

| Date | Change |
|---|---|
| 2026-08-17 | Admin-recommended resources |
| 2026-08-24 | Enterprise-managed MCP authorisation through the identity provider (e.g. Okta) |
| 2026-09-11 | Data residency in Japan |

**Pricing and seats** [S]
- From **2025-03-11**: Full / Dev / Collab / View seats, with a price rise of up to 33%. ([AlternativeTo](https://alternativeto.net/news/2024/12/figma-to-increase-subscription-plans-and-pricing-up-to-33-in-2025/); [UserJot](https://userjot.com/blog/figma-pricing-2025-plans-seats-costs-explained))
- **AI credits (now verified against primary sources, corrected):** [P] ([pricing](https://www.figma.com/pricing/); [How AI credits work](https://help.figma.com/hc/en-us/articles/33459875669015-How-AI-credits-work); [AI credit updates FAQ](https://help.figma.com/hc/en-us/articles/42614902212887-AI-credit-updates-FAQ))
  - Each seat carries a monthly allowance that resets every month and does not roll over.
    - Full seats: 3,000 (Professional), 3,500 (Organization) or 4,250 (Enterprise).
    - Other seats: 500.
    - Starter: 500, capped at 150 a day.
    - With no credits left, AI actions are blocked until an admin approves more or the allowance resets.
  - The FAQ says "In March of 2026, Figma introduced ways to purchase additional AI credits". March 2026 is when paid top-ups arrived, not when seats-plus-credits began.
  - On **2026-08-25**, add-on subscriptions got more credits at no extra cost: 2x on Professional and 1.6x on Organization and Enterprise.
  - The agent and Weave are free during the beta. They will start using credits at GA, which the FAQ says is "in a few weeks".

---

## 14. What moves and changes state (documented behaviour)

| What | Behaviour | Source |
|---|---|---|
| Starting a spotlight | Viewers get a notice with a few seconds to press **Not now**, then their view jumps to the presenter. The presenter's avatar gets a dashed border and a follower count appears. | [help](https://help.figma.com/hc/en-us/articles/360040322673-Present-to-collaborators-using-spotlight) [P] |
| Following someone | A border in their avatar colour frames your viewport, with a "following X" message at the top. | [help](https://help.figma.com/hc/en-us/articles/360040322673-Present-to-collaborators-using-spotlight), [blog 2018](https://www.figma.com/blog/figma-feature-highlight-observation-mode/) [P] |
| Cursor chat | The text bubble stays for 5 s after typing stops, then fades. After a longer idle it closes and returns you to the select tool. | [help](https://help.figma.com/hc/en-us/articles/1500004414842-Send-messages-with-cursor-chat) [P] |
| Audio | The speaker's avatar pops up in the toolbar and their cursor pulses with voice volume. | [help](https://help.figma.com/hc/en-us/articles/1500004414622-Use-audio-to-chat-with-your-team) [P] |
| Agent running | An animated loading indicator sits on the canvas for each running prompt; clicking it opens the chat. | [help](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files) [P] |
| Local edits vs server | Local edits apply immediately; conflicting server echoes are dropped so the canvas doesn't flicker. | [blog 2019](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) [P] |
| Offline, then back online | A blue toast at the bottom, an unsynced badge on the file, and **Open to sync**. Conflicts show **Review** / **Dismiss**. | [help](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma) [P] |
| Notification batching | Comment emails every 30 min; Dev status changes grouped per hour. | help [P] |
| Version timeline | Automatic checkpoints collapse between named versions. A restore adds two checkpoints. | help [P] |
| Resolving a comment | The pin disappears from the canvas and the list. **Show resolved comments** brings it back. | help [P] |
| Mirror | Frames selected on desktop update live on the phone. | mobile help [P] |
| Ask to edit | A red badge appears on the Share button until someone approves or denies. | help [P] |
| Folder tiles (2026-09-16) | Show previews of their files again, with stronger colours. | release notes [P] |

- **Not documented anywhere fetched:** durations, easing or spring values for any of the transitions above, the file browser, or the share modal. Figma describes what changes, not how the transitions are timed. [I]
- The UI3 blog (2024-06-26) covers floating, collapsible panels, the bottom toolbar and hiding the UI. It gives no motion specs, and notes that one layout experiment was reverted because controls moved around too much. [P] ([blog: Behind our redesign UI3](https://www.figma.com/blog/behind-our-redesign-ui3/))

---

## 15. Weaknesses and user complaints

| Issue | Evidence |
|---|---|
| Seat and permission are two separate gates. "I have can edit but I'm in view-only" is a recurring question. | [forum](https://forum.figma.com/ask-the-community-7/i-have-an-editor-access-but-is-on-view-only-mode-when-i-opened-the-file-28534) [C]; [help](https://help.figma.com/hc/en-us/articles/1500007609322-Guide-to-sharing-and-permissions) [P] |
| Prototype links exposed working files. The "can view prototypes only" role is gone, and prototype-only links need a paid plan. The right button is hidden in presentation view. | [forum](https://forum.figma.com/ask-the-community-7/prototype-only-link-prevent-client-access-to-working-files-30630), [forum](https://forum.figma.com/ask-the-community-7/what-happened-to-the-can-view-prototypes-only-permission-2787) [C] |
| Viewer and Dev Mode sharing permissions are bundled together. | [forum](https://forum.figma.com/suggest-a-feature-11/better-control-over-viewer-and-dev-mode-sharing-permissions-38327) [C] |
| The drafts migration led to many "files disappeared" reports. Org drafts cannot move plans without exporting a .fig. | [forum](https://forum.figma.com/report-a-problem-6/i-cant-find-my-files-40147) [C]; [help](https://help.figma.com/hc/en-us/articles/18409526530967-Updates-to-how-drafts-work) [P] |
| Folders launched without thumbnails and with weak, colour-only differentiation. Sort order resets. Fixed six weeks later. | [forum](https://forum.figma.com/share-your-feedback-26/figma-folders-57057) [C/P] |
| Comments attach only to top-level frames, not nested layers. | [forum](https://forum.figma.com/suggest-a-feature-11/keep-comments-pinned-to-design-elements-including-nested-17753) [C] |
| Deleted comments cannot be restored, even by restoring a version. | [help](https://help.figma.com/hc/en-us/articles/360041547593-View-and-manage-comments) [P] |
| Anonymous viewers of a public link cannot comment; sign-in is required. | [help](https://help.figma.com/hc/en-us/articles/360039824594-Comment-on-prototypes) [P] |
| Mobile cannot edit Design or Slides. Mirror is unstable. App Store screenshots imply editing. | [App Store](https://apps.apple.com/us/app/figma/id1152747299) [C] |
| Offline is shallow: you cannot open new files, there is no history, and Safari keeps edits for only 7 days. | [help](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma) [P] |
| Agent chats: only the creator can continue. Public-by-default could surprise people. No mobile. | [help](https://help.figma.com/hc/en-us/articles/41272399602583) [P] |
| Governance is tiered: passwords, expiry, workspace overrides and Governance+ are Enterprise or add-on only. | [help](https://help.figma.com/hc/en-us/articles/5726756336791-Manage-public-link-sharing-and-open-sessions) [P] |
| Pinned files cannot be reordered. Labels for favourites are inconsistent ("Starred" vs "Add to your favorites"). | help [P]; [I] |
| Pricing is complex (four seat types, AI credits) and hits freelancers. | [S] UserJot, AlternativeTo |
| Viewer history is a privacy trade-off: opt-out is per account only. | [help](https://help.figma.com/hc/en-us/articles/29638316371479-See-viewer-history-for-your-files) [P] |

---

## 16. Gaps in this research (not verified)

- Trash retention for files and folders. The "Delete and restore files" URL was not found. Trash and the **Deleted files** tab exist per the file browser guide.
- Grid or list view toggle, file tile anatomy (last edited, editor avatars), and presence on file tiles.
- Full details of Embed Kit 2.0.
- Slides presenter and audience features beyond the marketing page ([figma.com/slides](https://www.figma.com/slides/): presenter notes, co-presenting, live polls, alignment scale, playable prototypes, AI tone and notes) [P].
- Whether comments can be sent to the Figma agent.
- Numeric motion specs of any kind.
- ~~The primary source for the March 2026 AI-credit pricing change.~~ Found during the fact-check (see §13).
- How long activity logs are kept (365 days is unverified).

---

## 17. Side by side: Figma, Claude after the 16 Sept 2026 merge, and Juno today

Claude facts come from `claude-primary-evidence.md` and from the Artifact tool contract observed in this session, which describes share levels of view, comment and "writer"/edit. Juno facts come from `00-AUDIT-OVERVIEW.md` §4 and §12.7–12.8.

| Dimension | Figma (2026-09) | Claude (2026-09) | Juno today |
|---|---|---|---|
| Unit of made work | A typed **file** (Design, FigJam, Slides, Buzz, Sites, Make) inside a team/folder tree | A typed **artifact** (Design, Docs, Slides, Design System, or a plain page) at one URL; types are themselves artifacts | Ten concepts across two tables; DESIGN is an artifact with four editors (§4.1, §4.4) |
| Where it lives | Drafts per team, or folders (nested ≤10), Recents, Starred, pinned, Resources | Private by default; gallery; pin to sidebar; lives inside the conversation that made it | /artifacts, /design, /library, Outputs, Work stage; none complete (§12.2) |
| Owner and home when AI makes it | Agent/MCP-created files go to the chosen plan's **Drafts** by default (planKey required; an optional projectId puts them in a folder) | Owned by the user; lives in the conversation | Owned only through the conversation; deleting the chat deletes it (§12.1) |
| Access roles | Owner / can edit / can view, plus the seat gate; Inherited or Limited folders; user groups | View / comment / edit ("writer") shares; comment-only viewers cannot publish | Anonymous read-only snapshot; no grants; no commenter role (§12.8) |
| Link audience | Anyone / Org / Workspace / Invited; password; expiry (Enterprise); allow viewers to copy/export | One shareable link, private by default | Snapshot resolved by timestamp; opening the dialog publishes (§12.7) |
| Publishing | Separate **Publish/Update/Unpublish** for Make and Sites; figma.site URL; internal-only option | The artifact URL is both the working copy and the shared view; versions labelled on publish | No explicit publish step |
| Comments | Canvas pins or regions attached to top-level frames; threads, mentions, reactions, images, resolve, filters; notification tiers; 100/h | Anchored threads (`customAnchors`, `composer_only`); **send to Claude**, which arrives as a turn and Claude replies in the thread | Stored inside DesignDocument JSON; nothing writes them; no other type has comments (§12.1) |
| AI conversation visibility | Agent chats visible by default from 2026-06-23 (to anyone with file access, or to Full-seat editors; Figma's pages disagree); Shared/Private; link to chat; the agent can review and act on comments from the chat, with no comment-to-turn path evidenced | The artifact belongs to its conversation; sessions watch artifacts they publish | Ask Juno edits are not written to the transcript (§12.4) |
| Presence | Cursors, follow, spotlight, cursor chat, audio, viewer history | `room` capability (multiplayer presence), `user` (who is viewing); details not observed | None |
| Versions | Autosave every 30 min plus named versions; collapsed; restore is non-destructive; link to a version | Every publish is a version with optional label; conflict refusal; self-saving pages | Append-only for artifacts, folded in place for designs; `?v=` ignored (§12.3) |
| Review workflow | Ready for dev / Completed / Changed; branch review; Buzz approvals with lock | Not a documented type feature | None |
| Mobile | View, comment, mirror, prototypes; no Design or Slides editing; FigJam on iPad; no agent | Advertised as "open on your phone, edit directly" | Native can only share chats; iPhone editing uses a stale bundle (§4.3) |
| Offline | IndexedDB queue kept 30 days (Safari 7); unsynced badges; conflict review | Not documented | No offline artifact changes (§12.6) |
| Governance | Public-link toggles, passwords, expiry, activity log (CSV, API; retention unverified), Governance+, web-publish controls, MCP authorisation | Refuses to publish impersonation, fabricated records or phishing; Enterprise gets 30 days' notice | No takedown, report path, ban propagation, rate limits or quotas (§12.8) |

---

## 18. What this suggests for Juno [I]

1. **Build two sharing concepts from the start.**
   - **Grants:** live access for people as viewer, commenter or editor. This follows Figma's Owner/can edit/can view and adds the commenter role that Claude has and Figma lacks.
   - **Published snapshot:** pinned to a version id, with Figma-style **Publish → Update → Unpublish**, a visible Not published / Published state, and the URL kept when republishing.
   - Opening the share dialog must never publish anything.
2. **Model the share dialog on Figma's.**
   - Invite field, audience dropdown and role at the top.
   - A "Who has access" list ordered plan → inherited → people → groups.
   - **Ask to edit** / request access, with a red badge on Share while requests are pending.
   - Copy link that includes the selection (deep link to a node or artboard).
   - Password and expiry as governance options.
3. **Give comments their own table** keyed by (artifact, version, anchor).
   - Attach anchors to top-level containers (artboard, slide, block) so pins move with them.
   - Store a screenshot of the target at comment time, as Make does.
   - Resolve hides; filters for unread, resolved, mine and this page; **C** and **Shift+C**.
   - Support **send to Juno** as a turn (Claude's advantage).
   - Notification tiers of Everything / Mentions & replies / Nothing, with 30-minute email batching.
4. **Treat the chat that made an artifact as shareable provenance.**
   - Default it to visible to collaborators who can edit, with a per-chat Private switch and a link that checks permissions. This follows Figma's June 2026 model, though Figma's own pages disagree on whether that audience is "anyone with file access" or "Full-seat editors".
   - Show agent work on the canvas as an animated in-progress marker that opens the thread.
5. **One library page with previews and fixed placement.**
   - Include Recents, Starred, pinned items, and nested folders/projects.
   - Filter by type; search with ⌘/; results preview as you type.
   - Custom thumbnails via **Set as thumbnail**, and **Trash with restore** (Juno has no `deletedAt`).
   - Learn from Figma's Aug→Sep 2026 folder backlash: don't ship tiles without previews, don't use colour alone, and remember sort order.
   - Learn from Figma's drafts migration: AI-made artifacts need an owner (`userId`) and a known default home from the first day, so there is no later "Drafts to move" style migration.
6. **Versions:** named versions over collapsed autosaves; restore that keeps the state you left (Figma adds two checkpoints); links to specific versions; read-only browsing of old versions.
7. **Mobile baseline that matches Figma:** view, comment with long-press, quick reply from the notification, and live "mirror" of an open artifact. Claude's promise of editing on the phone is the bar to beat.
8. **Presence, phased in:** first "Currently viewing / Previously viewed" (cheap, useful for async work), then follow/spotlight with an avatar-coloured border and a **Not now** countdown.
9. **Review states:** add a generic status (e.g. Ready for review → Approved → Changed) with an approve-then-lock option, modelled on Figma's Ready for dev and Buzz approvals.
10. **Governance to ship with public sharing:**
    - Org toggles for public links, passwords and expiry.
    - An activity log of create, share, link change, view, export, trash and delete.
    - Rate limits: Figma caps comments at 100 per hour.
    - Takedown. The audit's X-01/X-32 interaction makes this urgent.

---

## Sources (with dates where known; "n.d." = undated help page, accessed 2026-09-23)

**Figma primary [P]**
- Updates to Figma's file management (effective 2026-08-03): https://help.figma.com/hc/en-us/articles/41753150926103-Updates-to-Figma-s-file-management
- Code, craft, and the making of nested folders (blog, 2026-08-03): https://www.figma.com/blog/code-craft-and-the-making-of-nested-folders/
- Release notes (entries 2026-08-13 to 2026-09-17): https://www.figma.com/release-notes/
- Rolling out: Projects become folders (forum staff post, 2026-08-03): https://forum.figma.com/product-updates-3/rolling-out-projects-become-folders-56675
- Figma folders feedback thread (2026-08-18/19, staff reply): https://forum.figma.com/share-your-feedback-26/figma-folders-57057
- Everything announced at Config 2026 (forum, 2026-06-24): https://forum.figma.com/product-updates-3/everything-announced-at-config-2026-55221
- What's new from Config 2026: https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026
- Config 2026 recap (blog): https://www.figma.com/blog/config-2026-recap/
- The Figma agent is here (blog, 2026-05-20): https://www.figma.com/blog/the-figma-agent-is-here/
- Work with the Figma agent in design files: https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files
- Manage chat visibility for the Figma agent: https://help.figma.com/hc/en-us/articles/41272399602583
- Guide to the file browser: https://help.figma.com/hc/en-us/articles/14381406380183-Guide-to-the-file-browser
- Guide to files and folders: https://help.figma.com/hc/en-us/articles/1500005554982-Guide-to-files-and-folders
- File and folder permissions: https://help.figma.com/hc/en-us/articles/35361119554711-File-and-folder-permissions
- Create a new file: https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file
- Search for files, folders, and people: https://help.figma.com/hc/en-us/articles/4422774037271-Search-for-files-folders-and-people
- Star your favorite files and folders: https://help.figma.com/hc/en-us/articles/360038511513-Star-your-favorite-files-and-folders
- Pin files to a folder: https://help.figma.com/hc/en-us/articles/360038511713-Pin-files-to-a-folder
- Find and use templates and resources: https://help.figma.com/hc/en-us/articles/31668820539287-Find-and-use-templates-and-resources-from-your-team-or-organization
- Set custom thumbnails for files: https://help.figma.com/hc/en-us/articles/360038511413-Set-custom-thumbnails-for-files
- Duplicate or copy files: https://help.figma.com/hc/en-us/articles/360038511533-Duplicate-or-copy-files
- Duplicate Community files: https://help.figma.com/hc/en-us/articles/360038510873-Duplicate-Community-files
- Updates to how drafts work (blog 2024-06-03): https://www.figma.com/blog/updates-to-how-drafts-work/ ; help: https://help.figma.com/hc/en-us/articles/18409526530967-Updates-to-how-drafts-work
- Share files and prototypes: https://help.figma.com/hc/en-us/articles/360040531773-Share-files-and-prototypes
- Guide to sharing and permissions: https://help.figma.com/hc/en-us/articles/1500007609322-Guide-to-sharing-and-permissions
- Request to edit a file: https://help.figma.com/hc/en-us/articles/4408435431319-Request-to-edit-a-file
- Embed files and prototypes: https://help.figma.com/hc/en-us/articles/360039827134-Embed-files-and-prototypes
- Guide to connected folders: https://help.figma.com/hc/en-us/articles/30124855491863-Guide-to-connected-folders
- Publish, update, or unpublish a Figma Make file: https://help.figma.com/hc/en-us/articles/31304586129559-Publish-update-or-unpublish-a-Figma-Make-file
- Publish, update, or unpublish a site: https://help.figma.com/hc/en-us/articles/31242845959703-Publish-update-or-unpublish-a-site
- Manage web publishing for an organization: https://help.figma.com/hc/en-us/articles/31242876956183-Manage-web-publishing-for-an-organization
- Guide to comments: https://help.figma.com/hc/en-us/articles/360039825314-Guide-to-comments-in-Figma
- Add comments to files: https://help.figma.com/hc/en-us/articles/360041068574-Add-comments-to-files
- View and manage comments: https://help.figma.com/hc/en-us/articles/360041547593-View-and-manage-comments
- Move or edit comments: https://help.figma.com/hc/en-us/articles/360041547853-Move-or-edit-comments
- Comments in FigJam: https://help.figma.com/hc/en-us/articles/1500004290941-Comments-in-FigJam
- Comment on prototypes: https://help.figma.com/hc/en-us/articles/360039824594-Comment-on-prototypes
- Add comments in Figma Make: https://help.figma.com/hc/en-us/articles/38701587731735-Add-comments-in-Figma-Make
- Comment email notifications: https://help.figma.com/hc/en-us/articles/360041547813-Manage-email-notifications-for-comments-on-files
- Manage your notification preferences: https://help.figma.com/hc/en-us/articles/360039813234-Manage-your-notification-preferences
- Get Figma notifications in Slack: https://help.figma.com/hc/en-us/articles/360039829154-Get-Figma-notifications-in-Slack
- Present to collaborators using spotlight: https://help.figma.com/hc/en-us/articles/360040322673-Present-to-collaborators-using-spotlight
- Facilitate meetings with spotlight: https://help.figma.com/hc/en-us/articles/5025214483351-Facilitate-meetings-with-spotlight
- Observation mode (blog 2018-08-02): https://www.figma.com/blog/figma-feature-highlight-observation-mode/
- Send messages with cursor chat: https://help.figma.com/hc/en-us/articles/1500004414842-Send-messages-with-cursor-chat
- Use audio to chat with your team: https://help.figma.com/hc/en-us/articles/1500004414622-Use-audio-to-chat-with-your-team
- Talk it out in Figma and FigJam (blog 2021-08-31): https://www.figma.com/blog/talk-it-out-in-figma-and-figjam/
- See viewer history for your files (launched February 2025; exact day unverified): https://help.figma.com/hc/en-us/articles/29638316371479-See-viewer-history-for-your-files
- How AI credits work: https://help.figma.com/hc/en-us/articles/33459875669015-How-AI-credits-work
- AI credit updates FAQ (credit increase effective 2026-08-25): https://help.figma.com/hc/en-us/articles/42614902212887-AI-credit-updates-FAQ
- Pricing: https://www.figma.com/pricing/
- How Figma's multiplayer technology works (blog 2019-10-16): https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- Behind our redesign: UI3 (blog 2024-06-26): https://www.figma.com/blog/behind-our-redesign-ui3/
- Dev Mode statuses and notifications: https://help.figma.com/hc/en-us/articles/26781702258583-Dev-Mode-statuses-and-notifications
- Dev Mode ready for dev view: https://help.figma.com/hc/en-us/articles/23918228264855-Dev-Mode-ready-for-dev-view
- Guide to branching: https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching
- Request a branch review: https://help.figma.com/hc/en-us/articles/5691414603543-Request-a-branch-review
- Use approvals in Figma Buzz: https://help.figma.com/hc/en-us/articles/39288847137815-Use-approvals-in-Figma-Buzz
- View a file's version history: https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history
- Name and annotate version history (blog): https://www.figma.com/blog/now-you-can-name-and-annotate-your-figma-version-history/
- Guide to the Figma mobile app: https://help.figma.com/hc/en-us/articles/1500007537281-Guide-to-the-Figma-mobile-app
- Figma on the App Store (v26.36.0, seen 2026-09-23): https://apps.apple.com/us/app/figma/id1152747299
- What can I do offline in Figma?: https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma
- Manage public link sharing and open sessions: https://help.figma.com/hc/en-us/articles/5726756336791-Manage-public-link-sharing-and-open-sessions
- Restrict access to content from outside your organization: https://help.figma.com/hc/en-us/articles/12080587805719-Restrict-access-to-content-from-outside-your-organization
- View and export activity logs: https://help.figma.com/hc/en-us/articles/360040449533-View-and-export-activity-logs
- Governance+ for Figma: https://help.figma.com/hc/en-us/articles/31825370509591-Governance-for-Figma
- Figma Slides product page: https://www.figma.com/slides/
- Local: Figma plugin skills `figma-create-new-file/SKILL.md`, `figma-use/references/plugin-api-standalone.d.ts` (2026 install)

**Claude primary [P]**
- Cowork is now Claude (blog, 2026-09-16): https://claude.com/blog/cowork-is-now-claude
- `docs/design/artifacts-design/research/claude-primary-evidence.md` (lead's first-hand observation, 2026-09-23)

**Secondary [S] and community [C]**
- AlternativeTo, nested folders (2026-08-04): https://alternativeto.net/news/2026/8/figma-introduces-nested-folders-for-improved-file-organization-and-team-collaboration/
- AlternativeTo, drafts relocation (2024-06): https://alternativeto.net/news/2024/6/figma-is-relocating-where-your-drafts-live-for-users-on-a-starter-and-professional-team
- AlternativeTo, connected projects (2025-04): https://alternativeto.net/news/2025/4/figma-adds-connected-projects-enhanced-collaboration-for-freelancers-and-agencies
- AlternativeTo, 2025 price rise (2024-12): https://alternativeto.net/news/2024/12/figma-to-increase-subscription-plans-and-pricing-up-to-33-in-2025/
- Releasebot aggregation of Figma release notes (Aug–Sep 2026): https://releasebot.io/updates/figma
- UserJot pricing explainer: https://userjot.com/blog/figma-pricing-2025-plans-seats-costs-explained
- Forum threads: prototype-only link https://forum.figma.com/ask-the-community-7/prototype-only-link-prevent-client-access-to-working-files-30630 ; can-view-prototypes-only https://forum.figma.com/ask-the-community-7/what-happened-to-the-can-view-prototypes-only-permission-2787 ; nested comments https://forum.figma.com/suggest-a-feature-11/keep-comments-pinned-to-design-elements-including-nested-17753 ; missing files https://forum.figma.com/report-a-problem-6/i-cant-find-my-files-40147 ; restore thumbnails (2026-08-19) https://forum.figma.com/suggest-a-feature-11/restore-file-thumbnail-previews-on-project-folders-is-it-possible-to-go-back-to-the-old-ui-of-viewing-all-project-folders-in-a-team-57087

---

## Fact-check (adversarial pass, 2026-09-23)

**Method**
- I re-fetched each cited Figma URL with WebFetch and asked for verbatim quotes.
- I cross-checked against a second Figma page wherever one existed: the forum staff post, the Config 2026 help page, pricing, the AI-credit FAQ, the Releasebot aggregator, and the live `create_new_file` schema of the Figma MCP server.
- The WebSearch budget was already used up, so no new sources could be discovered. Everything below comes from fetching known URLs.

**Verified [P]**
- **File management update (2026-08-03):**
  - Projects became folders, with 10-level nesting on paid plans.
  - "Same as team" became Inherited and "Disable" became Limited. The View-only option was removed and those users were added individually.
  - Professional can limit top-level folders only; Organization and Enterprise can limit any folder.
  - Also confirmed: seat choice at invite, no automatic folder access, a single admin role, the "Limited Access" badge, folder colours, and old project links redirecting.
- **Folder follow-up (release notes, 2026-09-16):** "Preview what's inside folders", more distinct colours, and duplicating folders. Tom Reem's forum reply says the same. The forum complaints (thumbnails, colour-only accessibility, file counts, emoji or icons, sort order resetting) are confirmed in the two threads.
- **Agent panel:** "Pop out Agents panel" (release notes, 2026-08-26, desktop macOS and Windows). The agent is only in Figma Design, on desktop and web; it is not on mobile.
- **Agent chats:**
  - the Shared chat / Private chat toggle under More options;
  - "Make your existing chats private";
  - private chats cannot be linked;
  - only the creator can continue a chat;
  - chats from before 2026-06-23 stay private.
- **Make publishing:**
  - `three-random-words.figma.site`;
  - changes appear only after you update;
  - the same URL is reused on republish;
  - custom passwords of 4 or more characters, or Figma-generated four-word passwords;
  - "You can't add a password if the audience is set to internal-only".
- **Make comments:** a screenshot of the element is captured when the comment is placed; the sidebar is grouped into Current version and Other versions; threads close with Mark as resolved; there is no commenting on the published app.
- **Comments:**
  - 100 per hour, including replies, across all files;
  - up to 5 PNG, JPEG or GIF images;
  - pins attach only to top-level frames, components or groups;
  - deletion is permanent even after a version restore;
  - the sort and filter list is as described, and Shift+C works as described;
  - comment emails are grouped every 30 minutes (on the preferences page);
  - the in-app bell holds 50 notifications and cannot be disabled.
- **Mobile:** no editing of Design or Slides; FigJam editing on iPad; Make is preview-only; tabs are Recents, Search, Activity and Mirror; iOS 16+ and Android 8+. The App Store shows version 26.36.0, rated 4.6 from about 21K ratings. id6756397299 is indeed "Figma for Government" by Figma Inc.
- **Offline:**
  - IndexedDB for up to 30 days, 7 in Safari;
  - a blue notification, an unsynced changes icon, and Open to sync;
  - Review or Dismiss on conflicts;
  - "Create one new Figma file".
- **Public-link governance:**
  - Organization and Enterprise can disable public links;
  - Enterprise can require passwords and auto-generated four-word passwords, and set expiry from 1 hour to 31 days, which disables FigJam public links;
  - FigJam open sessions last 24 hours;
  - drafts use the org default.
- **Activity log:** "Viewed a file" events, IP address per event, AI-feature events, CSV export by email, and the Enterprise Activity Logs API.
- **Governance+:**
  - an Enterprise and Figma for Government add-on;
  - the discovery pipeline includes "the user-authored portion of prompts to AI features", kept for 30 days;
  - also confirmed: IP allowlist (IPv4), 15-minute idle timeout, EKM, AI hosting controls, the Developer Logs API for REST and MCP, extra authentication for guests, multiple identity providers, policies users must accept, and support-access controls.
- **MCP `create_new_file`:** planKey from whoami; editorType design, figjam or slides; files go to Drafts by default.
- **Viewer history:** signed-in members and invited guests are recorded; public-link visitors are not; opt-out is per account; paid plans only; February 2025.
- **Other features spot-checked and correct as written:**
  - Create menu and quick URLs (including the real `flides.new`); Weave sits outside the file browser.
  - Starred items (all four methods, reorderable); pinned files (edit access, order fixed); custom thumbnails (1920×1080).
  - Search (⌘/, filters, sorts); file browser sidebar order; Duplicate (`/duplicate`, "Copy of", no comments or history).
  - Ask to edit (red badge on Share); seat vs permission gate.
  - Embeds, including Embed Kit 2.0; connected folders (3/6/15; AlternativeTo 2025-04-10 for "connected projects").
  - Spotlight, audio, Dev Mode statuses (grouped per hour, Teams supported), and branching.
  - Drafts migration dates (2024-10-15 → 2025-10-09).
  - Web-publishing admin controls; admin-recommended resources (2026-08-17 per Releasebot [S]; not on the Resources help page); data residency in Japan (2026-09-11, Releasebot [S]).

**Corrected (partly wrong or refuted)**
1. **Agent chat default audience.** The earlier text said "Full seat and edit access". The chat-visibility article says "anyone with access to the file", and the Config 2026 help page says Full seat plus edit access within the org or team. The notes now record both. Plan availability also varies by page.
2. **Agent and comments.** The earlier text said the agent could only "summarize feedback". The agent help page lists "Summarize, sort, and take action on comments in the design file" and "Review comments". What remains true is that no source shows a comment being routed to the agent as a turn, or the agent replying in a thread. Claude's comment-to-turn bridge is still a difference, but a narrower one.
3. **Pricing.** "Seats plus AI credits from March 2026" is imprecise.
   - Primary sources show per-seat monthly credits: Full 3,000, 3,500 or 4,250; others 500.
   - "In March of 2026, Figma introduced ways to purchase additional AI credits".
   - Add-on credits were increased on 2026-08-25.
   - The agent and Weave are free in beta and will cost credits at GA.
4. **Version history shortcut.** ⌥⌘S saves a version; it does not open history. The panel opens only from the file-name menu.
5. **Buzz approvals.** "Complete" is the reviewer's **Mark as complete** action, not a status badge. Required approvals also block export.
6. **Nested-folders blog.** The blog does not mention breadcrumbs, drag-and-drop or folder colours; it covers the share-modal inheritance work. Folder colours come from the help page and the forum. Breadcrumbs and drag-and-drop are now tagged unverified.
7. **Drafts shared with "Anyone" are view-only.** This applies to Starter-team drafts specifically.
8. **MCP placement.** The live tool schema has an optional `projectId`, so agent-created files can go straight into a folder. Drafts is only the default.
9. **Sites publishing.** Added the publish-history revert. The per-page passwords and "Professional 10 domains / unlimited" are tagged unverified. The only confirmed fact is that Make and Sites share one domain limit.

**Tagged unverified**
- Activity-log retention of 365 days: not on the help page or in the API docs.
- The exact day of the viewer-history launch (2025-02-24): the help page says only "February 2025".
- "Share modals now list more people" after the View-only migration.
- Microsoft Teams as a channel for comment notifications. It is documented for Dev Mode statuses only.
- Cursor-chat details in Figma Design: the cited article is written for FigJam only.
