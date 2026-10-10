import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

/// The Library: what Alevr made and every file you gave it, shown as what each
/// one actually is — the website's `/library` and the Mac's Library screen.
///
/// **The web's shape, on a phone.** The serif heading with Recently deleted and
/// Upload under it; the two shelves Alevr fills itself (Made by Alevr,
/// Artifacts) as tiles with their own drawings; then one row of controls — All
/// / Images / Documents and List / Grid, each a glass capsule — and the files.
/// **Grid** by default: a file you sent is recognised by sight, so each tile is
/// the file itself — the photo, or a document's first page as QuickLook draws
/// it — and nobody has to remember `IMG_4821.HEIC`. List keeps a small real
/// thumbnail on every row. A tap opens the file in QuickLook.
///
/// **The second half of this screen is local.** `Add Document…` reads a file on
/// this phone — or in iCloud Drive, or in any Files provider — through
/// ``DocumentIngestionPipeline`` into the account's retrieval index, so the
/// search field finds passages *inside* a PDF and not only file names.
struct JunoMobileLibraryView: View {
  @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
  /// This phone's local document index. See
  /// ``JunoMobileRootView``, which owns it so it survives leaving this tab.
  var documentIndex: NativeDocumentIndexModel?
  /// Everything the image editor needs. All optional, and the Edit action is
  /// absent rather than disabled when any of it is missing — a menu item that
  /// cannot work is worse than one that is not there.
  var accountID: AccountID?
  var attachmentClient: NativeAttachmentAPIClient?
  var generateClient: NativeChatAPIClient?
  var modelCatalog: [NativeChatModelOption] = []
  var openConversation: ((String) -> Void)?
  /// What Alevr made (`/api/library/made`); nil hides the shelf that opens it.
  var madeModel: NativeLibraryMadeModel? = nil
  var artifactModel: NativeArtifactModel<SQLiteAccountRepository>? = nil
  var workClient: NativeWorkClient? = nil
  /// Opens Artifacts, which the phone drawer folds into Library.
  var openArtifacts: (() -> Void)? = nil
  /// The Library's own routes (`/api/library`): Upload and Recently deleted.
  /// Nil leaves both out — absent, not disabled.
  var libraryClient: NativeLibraryClient? = nil

  enum Presentation: String, CaseIterable {
    case grid, list
  }

  @State private var editing: NativeProjectFile?
  /// Opens "Made by Alevr" straight away: `--juno-preview-library-made` (DEBUG).
  @State private var showingMade = false
  /// Opens Recently deleted straight away: `--juno-preview-library-deleted` (DEBUG).
  @State private var showingDeleted = false

  @State private var filter: JunoLibraryFilter = .all
  @State private var sort: JunoLibrarySort = .newest
  @State private var searchText = ""
  @State private var previews = NativeFilePreviewLoader()
  @State private var previewURL: URL?
  @State private var renameFileID: String?
  @State private var renameValue = ""
  @State private var localError: String?
  /// Whether the Files picker for `Add Document…` is up.
  @State private var choosingDocument = false
  /// Whether the Files picker for Upload is up.
  @State private var choosingUpload = false
  /// Which of the two the one picker is serving. Kept apart from the two
  /// flags, which the picker clears as it closes.
  @State private var importIndexes = false
  /// A failure of the *picker*, not of the pipeline. Kept apart from
  /// `documentIndex.lastErrorDescription`: "the picker errored" and "this PDF
  /// has no text in it" want different sentences.
  @State private var documentPickerFailure: String?
  /// The Library's page model, for its uploads: built on first appearance.
  @State private var uploader: NativeLibraryPageModel?
  @State private var headingPassed = false
  /// Remembered across launches, Grid by default.
  @AppStorage("juno.mobile.library.view") private var storedPresentation = Presentation.grid.rawValue
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var presentation: Presentation { Presentation(rawValue: storedPresentation) ?? .grid }

  /// `libraryFiles`, not `files`: a file taken out of the Library is still
  /// synced, because the chat or project that uses it still shows it.
  private var files: [NativeProjectFile] {
    JunoLibraryFilter.apply(
      model.libraryFiles, filter: filter, search: searchText, sort: sort
    )
  }

  private var canUpload: Bool { libraryClient != nil && attachmentClient != nil && accountID != nil }
  private var showsShelves: Bool {
    (madeModel != nil || openArtifacts != nil) && filter == .all && searchText.isEmpty
  }

  var body: some View {
    Group {
      if model.phase == .loading || model.phase == .idle {
        JunoMobileQuietLoading()
      } else {
        page
      }
    }
    .background(Color.junoCanvas.ignoresSafeArea())
    .junoMobileSerifTitle(String(localized: "Library"), revealed: headingPassed)
    .searchable(text: $searchText, prompt: Text("library.search"))
    .alert("Rename file", isPresented: Binding(
      get: { renameFileID != nil },
      set: { if !$0 { renameFileID = nil } }
    )) {
      TextField("File name", text: $renameValue)
      Button("Cancel", role: .cancel) { renameFileID = nil }
        .contentShape(.rect)
      Button("Save") {
        guard let id = renameFileID else { return }
        renameFileID = nil
        Task { await model.renameFile(id: id, fileName: renameValue) }
      }
      .contentShape(.rect)
    }
    .alert("File unavailable", isPresented: Binding(
      get: { localError != nil },
      set: { if !$0 { localError = nil } }
    )) {
      Button("OK") { localError = nil }
        .contentShape(.rect)
    } message: {
      Text(localError ?? "Try again.")
    }
    .quickLookPreview($previewURL)
    // One picker for both directions: Add Document… reads into this phone's
    // index, Upload sends to the account. Two `fileImporter`s on one screen
    // fight over which one presents.
    .fileImporter(
      isPresented: Binding(
        get: { choosingDocument || choosingUpload },
        set: { if !$0 { choosingDocument = false; choosingUpload = false } }
      ),
      allowedContentTypes: importIndexes ? NativeDocumentIndexModel.readableContentTypes : [.item],
      // Several at once, read one after another: the pipeline reports one
      // file at a time, and a parallel import would make the progress line
      // name whichever happened to finish last.
      allowsMultipleSelection: true
    ) { result in
      let indexing = importIndexes
      switch result {
      case let .success(urls):
        if indexing {
          documentPickerFailure = nil
          Task { await ingest(urls) }
        } else {
          upload(urls)
        }
      case let .failure(error):
        if indexing { documentPickerFailure = error.localizedDescription } else { localError = error.localizedDescription }
      }
    }
    // One search field, two corpora. It already narrowed the account's files
    // by name; this is what makes the same keystrokes look *inside* the
    // documents indexed on this phone.
    .onChange(of: searchText) { _, value in documentIndex?.setQuery(value) }
    .navigationDestination(isPresented: $showingMade) { madeDestination }
    .navigationDestination(isPresented: $showingDeleted) { deletedDestination }
    .task {
      if uploader == nil, let libraryClient, let accountID {
        let page = NativeLibraryPageModel(client: libraryClient, uploader: attachmentClient)
        page.start(for: accountID)
        uploader = page
      }
      #if DEBUG
        if CommandLine.arguments.contains("--juno-preview-library-made"), madeModel != nil {
          try? await Task.sleep(for: .milliseconds(600))
          showingMade = true
        }
        if CommandLine.arguments.contains("--juno-preview-library-deleted"), libraryClient != nil {
          try? await Task.sleep(for: .milliseconds(600))
          showingDeleted = true
        }
        // `--juno-preview-library-open <id>`: the file's QuickLook preview,
        // opened as a tap would open it.
        if let index = CommandLine.arguments.firstIndex(of: "--juno-preview-library-open"),
          index + 1 < CommandLine.arguments.count
        {
          let id = CommandLine.arguments[index + 1]
          // The synced files land a moment after the screen does.
          for _ in 0..<40 {
            if let file = model.libraryFiles.first(where: { $0.id == id }) {
              try? await Task.sleep(for: .milliseconds(600))
              open(file)
              break
            }
            try? await Task.sleep(for: .milliseconds(250))
          }
        }
        // The harness states the view every launch, so one capture's List
        // does not leak into the next one's Grid.
        if CommandLine.arguments.contains("--juno-ui-preview") {
          storedPresentation = CommandLine.arguments.contains("--juno-preview-library-list")
            ? Presentation.list.rawValue : Presentation.grid.rawValue
        }
        if let index = CommandLine.arguments.firstIndex(of: "--juno-preview-library-filter"),
          index + 1 < CommandLine.arguments.count,
          let preset = JunoLibraryFilter(rawValue: CommandLine.arguments[index + 1])
        {
          filter = preset
        }
      #endif
    }
    // An upload that finished is a file the account now holds: sync it in so
    // it lands in the grid as a tile, not as a pending row.
    .onChange(of: uploader?.uploads.count ?? 0) { old, new in
      if new < old { Task { await model.reload() } }
    }
    .sheet(item: $editing) { file in
      if let accountID, let attachmentClient, let generateClient {
        NativeImageEditSheet(
          attachmentID: file.id,
          fileName: file.fileName,
          accountID: accountID,
          attachments: attachmentClient,
          client: generateClient,
          models: modelCatalog,
          openConversation: openConversation,
          close: { editing = nil }
        )
      }
    }
  }

  /// Only an image, and only when the manifest says some available model can
  /// edit one. Offering the action otherwise would open an editor whose
  /// Generate button could never be pressed.
  private func canEdit(_ file: NativeProjectFile) -> Bool {
    file.kind.uppercased() == "IMAGE"
      && accountID != nil && attachmentClient != nil && generateClient != nil
      && modelCatalog.contains { $0.modality == "image" && $0.imageEditSupport != .none }
  }

  // MARK: - Page

  private var page: some View {
    GeometryReader { proxy in
      let width = min(proxy.size.width, JunoMobileProjectPageMetrics.measure + JunoLayout.Page.gutter * 2)
        - JunoLayout.Page.gutter * 2
      ScrollView {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
          heading
          if model.phase == .offline || model.lastErrorDescription != nil {
            statusRow
          }
          if showsShelves {
            shelves
          }
          documentIndexSection
          VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if !model.libraryFiles.isEmpty || !(uploader?.uploads.isEmpty ?? true) {
              controls
            }
            uploadsInFlight(width: width)
            if files.isEmpty {
              empty
            } else if presentation == .grid {
              grid(width: width)
            } else {
              list
            }
          }
        }
        .padding(.horizontal, JunoLayout.Page.gutter)
        .padding(.top, JunoSpace.snug)
        .padding(.bottom, JunoSpace.vast)
        .frame(maxWidth: JunoMobileProjectPageMetrics.measure + JunoLayout.Page.gutter * 2)
        .frame(maxWidth: .infinity)
      }
      .junoMobileTracksHeading($headingPassed, threshold: JunoSpace.vast + JunoSpace.cozy)
      .refreshable { await model.reload() }
      .scrollDismissesKeyboard(.interactively)
      .accessibilityIdentifier("juno.mobile.file-list")
    }
  }

  // MARK: Heading

  private var heading: some View {
    VStack(alignment: .leading, spacing: JunoSpace.regular) {
      JunoMobileSerifHeading(
        String(localized: "Library"),
        lede: madeModel == nil
          ? String(localized: "Everything you upload or share in chats.")
          : String(localized: "What Alevr made and the files you gave it.")
      )
      HStack(spacing: JunoSpace.snug) {
        // Withheld while the empty state carries "Upload files": one Upload
        // per screen, as the Mac does.
        if canUpload, !model.libraryFiles.isEmpty {
          Button {
            importIndexes = false
            choosingUpload = true
          } label: {
            JunoMobileCapsuleLabel(String(localized: "Upload"), icon: .upload)
          }
          .junoMobileCapsulePrimary()
          .contentShape(Capsule())
          .accessibilityIdentifier("juno.mobile.library-upload")
        }
        if libraryClient != nil, accountID != nil {
          NavigationLink {
            deletedDestination
          } label: {
            JunoMobileCapsuleLabel(String(localized: "Recently deleted"), icon: .trash)
          }
          .junoMobileCapsuleAction()
          .contentShape(Capsule())
          .accessibilityIdentifier("juno.mobile.library-recently-deleted")
        }
        Spacer(minLength: 0)
        moreMenu
      }
    }
  }

  /// Add Document… and Refresh, behind one glass circle.
  private var moreMenu: some View {
    Menu {
      // Absent, not disabled, when there is no index to put a document in —
      // the rule the Edit Image action follows for the same reason. Absent
      // while a read is in flight too: two imports racing would make the
      // progress line describe neither.
      if let documentIndex, documentIndex.isReady, !documentIndex.isIngesting {
        Button {
          documentPickerFailure = nil
          importIndexes = true
          choosingDocument = true
        } label: {
          JunoIconLabel(verbatim: "Add Document…", icon: .filePlus)
        }
        .accessibilityIdentifier("juno.mobile.library-add-document")
      }
      Button {
        Task { await model.reload() }
      } label: {
        JunoIconLabel("library.refresh", icon: .refresh)
      }
    } label: {
      JunoMobileCircleGlyph(icon: .ellipsis, label: String(localized: "More library actions"))
    }
    .junoMobileCircleAction()
    .contentShape(Circle())
    .accessibilityIdentifier("juno.mobile.library-options")
  }

  // MARK: Shelves

  /// What Alevr made, and the artifacts from chats: two tiles side by side,
  /// each with its own small drawing, rather than two grey rows.
  private var shelves: some View {
    LazyVGrid(
      columns: Array(repeating: GridItem(.flexible(), spacing: JunoSpace.cozy, alignment: .top), count: 2),
      spacing: JunoSpace.cozy
    ) {
      if madeModel != nil {
        NavigationLink {
          madeDestination
        } label: {
          JunoMobileLibraryEntryTile(
            title: String(localized: "Made by Alevr"),
            detail: String(localized: "Pages, documents, spreadsheets and decks"),
            art: .made
          )
        }
        .buttonStyle(NativeFilePreviewPressStyle())
        .contentShape(.rect(cornerRadius: JunoRadius.card))
        .accessibilityIdentifier("juno.mobile.library-made")
      }
      if let openArtifacts {
        Button(action: openArtifacts) {
          JunoMobileLibraryEntryTile(
            title: String(localized: "Artifacts"),
            detail: String(localized: "Code, pages and diagrams from your chats"),
            art: .artifacts
          )
        }
        .buttonStyle(NativeFilePreviewPressStyle())
        .contentShape(.rect(cornerRadius: JunoRadius.card))
        .accessibilityIdentifier("juno.mobile.library-artifacts")
      }
    }
  }

  // MARK: Controls

  /// All / Images / Documents and List / Grid on one row, then the count and
  /// the sort under it. On a narrow phone at a large text size the two
  /// capsules stack rather than overflow.
  private var controls: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: JunoSpace.snug) {
          filterControl
          Spacer(minLength: 0)
          viewControl
        }
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
          filterControl
          viewControl
        }
      }
      HStack(spacing: JunoSpace.snug) {
        Text(countLine)
          .junoFont(size: 13, relativeTo: .footnote)
          .monospacedDigit()
          .foregroundStyle(Color.junoSecondaryInk)
        Spacer(minLength: 0)
        Menu {
          Picker("library.sort", selection: $sort) {
            ForEach(JunoLibrarySort.allCases) { option in
              Text(option.title).tag(option)
            }
          }
        } label: {
          HStack(spacing: JunoSpace.hairline) {
            Text(sort.title)
            JunoIconView(.chevronsUpDown, size: 12)
          }
          .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
          .foregroundStyle(Color.junoSecondaryInk)
          .frame(minHeight: JunoLayout.touchTarget)
          .contentShape(.rect)
        }
        .accessibilityLabel("Sort files")
        .accessibilityIdentifier("juno.mobile.library-sort")
      }
    }
  }

  private var filterControl: some View {
    JunoMobileCapsuleSegmented(
      options: [
        .init(JunoLibraryFilter.all, String(localized: "All")),
        .init(JunoLibraryFilter.images, String(localized: "Images")),
        .init(JunoLibraryFilter.documents, String(localized: "Documents")),
      ],
      selection: $filter,
      accessibilityLabel: String(localized: "Filter by type")
    )
    .fixedSize()
    .accessibilityIdentifier("juno.mobile.library-filter")
  }

  private var viewControl: some View {
    JunoMobileCapsuleSegmented(
      options: [
        .init(Presentation.grid, String(localized: "Grid"), icon: .grid),
        .init(Presentation.list, String(localized: "List"), icon: .list),
      ],
      selection: Binding(get: { presentation }, set: { storedPresentation = $0.rawValue }),
      accessibilityLabel: String(localized: "View"),
      iconOnly: true
    )
    .fixedSize()
    .accessibilityIdentifier("juno.mobile.library-view")
  }

  private var countLine: String {
    let count = files.count
    let total = model.libraryFiles.count
    let noun = count == 1 ? String(localized: "file") : String(localized: "files")
    return count == total ? "\(count) \(noun)" : String(localized: "\(count) of \(total) files")
  }

  // MARK: Grid and list

  private func grid(width: CGFloat) -> some View {
    LazyVGrid(columns: JunoMobileLibraryMetrics.columns(forWidth: width), spacing: JunoSpace.cozy) {
      ForEach(files) { file in
        item(file) { request in
          JunoMobileFileTile(
            request: request,
            state: previews.state(for: file.id),
            date: file.createdAt
          )
        }
      }
    }
    .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: files.map(\.id))
  }

  private var list: some View {
    LazyVStack(spacing: 0) {
      ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
        if index > 0 {
          Divider().padding(.leading, JunoLayout.touchTarget + JunoSpace.cozy + JunoSpace.cozy)
        }
        item(file) { request in
          JunoMobileFileRowLabel(
            request: request,
            state: previews.state(for: file.id),
            date: file.createdAt
          )
          .padding(.horizontal, JunoSpace.cozy)
        }
      }
    }
    .background(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .fill(Color.junoCard)
    )
    .overlay(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
    )
    .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: files.map(\.id))
  }

  /// One file, in either presentation: opens its preview on a tap, carries
  /// its actions in the context menu, and loads its thumbnail once on screen.
  private func item<Label: View>(
    _ file: NativeProjectFile,
    @ViewBuilder label: (NativeFilePreviewRequest) -> Label
  ) -> some View {
    let request = NativeFilePreviewRequest(file)
    return Button {
      open(file)
    } label: {
      label(request)
    }
    .buttonStyle(NativeFilePreviewPressStyle())
    .contentShape(.rect(cornerRadius: JunoRadius.card))
    .contextMenu {
      Button { open(file) } label: { SwiftUI.Label("Open", image: JunoIcon.eye.assetName(.regular)) }
      if canEdit(file) {
        Button { editing = file } label: { SwiftUI.Label("Edit Image…", image: JunoIcon.sparkles.assetName(.regular)) }
      }
      Button { beginRename(file) } label: { SwiftUI.Label("Rename", image: JunoIcon.pencil.assetName(.regular)) }
      Divider()
      let removal = JunoLibraryRemovalLabel(file.libraryUse)
      Button(role: .destructive) {
        Task { await model.removeFromLibrary(id: file.id) }
      } label: {
        SwiftUI.Label(removal.title, image: JunoIcon.trash.assetName(.regular))
        if let detail = removal.detail { Text(detail) }
      }
    }
    .task(id: file.id) { await previews.load(request) { await model.accessFile(id: file.id) } }
  }

  /// Files on their way up, as tiles that say so — the web's `UploadTile`.
  @ViewBuilder
  private func uploadsInFlight(width: CGFloat) -> some View {
    if let uploader, !uploader.uploads.isEmpty {
      LazyVGrid(columns: JunoMobileLibraryMetrics.columns(forWidth: width), spacing: JunoSpace.cozy) {
        ForEach(uploader.uploads) { upload in
          JunoMobileLibraryUploadTile(
            upload: upload,
            retry: { uploader.retryUpload(upload.id) },
            dismiss: { uploader.dismissUpload(upload.id) }
          )
        }
      }
    }
  }

  private func beginRename(_ file: NativeProjectFile) {
    renameValue = file.fileName
    renameFileID = file.id
  }

  @ViewBuilder
  private var madeDestination: some View {
    if let madeModel {
      JunoMobileLibraryMadeView(
        model: madeModel,
        artifactModel: artifactModel,
        accountID: accountID,
        workClient: workClient,
        openConversation: openConversation
      )
    }
  }

  @ViewBuilder
  private var deletedDestination: some View {
    if let libraryClient, let accountID {
      JunoMobileLibraryDeletedView(
        client: libraryClient,
        accountID: accountID,
        restored: { Task { await model.reload() } }
      )
    }
  }

  /// Offline or a failed refresh, as one quiet card with Retry.
  private var statusRow: some View {
    HStack(spacing: JunoSpace.cozy) {
      JunoSymbol(model.phase == .offline ? JunoIcon.wifiOff : JunoIcon.triangleAlert)
        .foregroundStyle(Color.junoSecondaryInk)
        .accessibilityHidden(true)
      Text(model.lastErrorDescription ?? "Offline — showing saved files.")
        .junoFont(size: 14, relativeTo: .subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
        .lineLimit(2)
      Spacer(minLength: 0)
      Button("Retry") { Task { await model.reload() } }
        .junoMobileCapsuleAction(.small)
        .contentShape(Capsule())
    }
    .padding(JunoSpace.cozy)
    .background(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .fill(Color.junoCard)
    )
  }

  // MARK: - Local document index

  /// What the on-device index has to say, or nothing at all: a summary line,
  /// any failure, then the matching passages, in one card.
  @ViewBuilder
  private var documentIndexSection: some View {
    if let index = documentIndex, index.isReady, indexPanelHasContent(index) {
      VStack(alignment: .leading, spacing: JunoSpace.snug) {
        Text("On this iPhone")
          .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
          .foregroundStyle(Color.junoSecondaryInk)
          .accessibilityAddTraits(.isHeader)
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
          indexSummary(index)
          if let failure = documentPickerFailure ?? index.lastErrorDescription {
            indexFailure(failure, index: index)
          }
          indexResults(index)
        }
        .padding(JunoSpace.cozy)
        .background(
          RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
            .fill(Color.junoCard)
        )
        .overlay(
          RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
            .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
        )
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Documents indexed on this phone")
      .accessibilityIdentifier("juno.mobile.library-document-index")
    }
  }

  private func indexPanelHasContent(_ index: NativeDocumentIndexModel) -> Bool {
    !index.documents.isEmpty
      || index.isIngesting
      || index.lastErrorDescription != nil
      || documentPickerFailure != nil
  }

  private func indexSummary(_ index: NativeDocumentIndexModel) -> some View {
    HStack(spacing: JunoSpace.cozy) {
      JunoSymbol(.fileSearch)
        .foregroundStyle(Color.junoSecondaryInk)
        .accessibilityHidden(true)
      Text(indexSummaryLine(index))
        .junoFont(size: 14, relativeTo: .subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
        .lineLimit(2)
      Spacer(minLength: 0)
      if index.isIngesting {
        ProgressView()
          .controlSize(.small)
          .accessibilityHidden(true)
      } else if !index.documents.isEmpty {
        Menu {
          ForEach(index.documents) { document in
            Button("Remove \(document.sourceName)", role: .destructive) {
              Task { await index.remove(document) }
            }
          }
        } label: {
          JunoSymbol(.ellipsis)
            .foregroundStyle(Color.junoSecondaryInk)
            .frame(width: JunoLayout.touchTarget, height: JunoLayout.touchTarget)
            .contentShape(.rect)
        }
        .accessibilityLabel("Manage indexed documents")
        .accessibilityIdentifier("juno.mobile.library-document-index-manage")
      }
    }
  }

  /// The counts come from the index, and the OCR clause appears only when some
  /// document really was transcribed. The memory-only note is stated rather
  /// than assumed: nothing here writes document text to disk.
  private func indexSummaryLine(_ index: NativeDocumentIndexModel) -> String {
    if let name = index.ingestingFileName { return "Reading \(name)…" }
    guard !index.documents.isEmpty else {
      return "No documents indexed on this phone."
    }
    let documents = index.documents.count
    var line = "\(documents) \(documents == 1 ? "document" : "documents")"
    line += " · \(index.chunkCount) searchable \(index.chunkCount == 1 ? "passage" : "passages")"
    line += ", kept on this phone until you quit"
    if index.documents.contains(where: \.usedOpticalCharacterRecognition) {
      line += " · some text was read by OCR"
    }
    return line
  }

  private func indexFailure(_ message: String, index: NativeDocumentIndexModel) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
      JunoSymbol(.triangleAlert)
        .foregroundStyle(Color.junoCaution)
        .accessibilityHidden(true)
      Text(message)
        .junoFont(size: 14, relativeTo: .subheadline)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      Button("Dismiss") {
        documentPickerFailure = nil
        index.clearError()
      }
      .contentShape(.rect)
      .junoFont(size: 14, relativeTo: .subheadline)
    }
    .accessibilityIdentifier("juno.mobile.library-document-index-error")
  }

  /// Three states, kept apart because collapsing any two says something untrue:
  /// nothing when no question was asked, "searching" while the ranker runs, and
  /// "nothing mentions …" only once a search has actually come back empty.
  @ViewBuilder
  private func indexResults(_ index: NativeDocumentIndexModel) -> some View {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    if !query.isEmpty, !index.documents.isEmpty {
      if index.isSearching, index.passages.isEmpty {
        Text("Searching your documents…")
          .junoFont(size: 14, relativeTo: .subheadline)
          .foregroundStyle(Color.junoSecondaryInk)
      } else if index.passages.isEmpty {
        Text("No indexed document mentions “\(query)”.")
          .junoFont(size: 14, relativeTo: .subheadline)
          .foregroundStyle(Color.junoSecondaryInk)
      } else {
        ForEach(index.passages) { passage in
          passageRow(passage)
        }
      }
    }
  }

  /// One hit: where it came from, then what it says.
  private func passageRow(_ passage: NativeDocumentPassage) -> some View {
    VStack(alignment: .leading, spacing: JunoSpace.micro) {
      Text(passage.locator)
        .junoFont(size: 12, relativeTo: .caption)
        .foregroundStyle(Color.junoSecondaryInk)
        .lineLimit(1)
        .truncationMode(.middle)
      Text(passage.text)
        .junoFont(size: 14, relativeTo: .subheadline)
        .lineLimit(4)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(passage.locator). \(passage.text)")
    .accessibilityIdentifier("juno.mobile.library-document-passages")
  }

  /// Reads the chosen files one after another, so the progress line always
  /// names the file actually being read.
  private func ingest(_ urls: [URL]) async {
    guard let documentIndex else { return }
    for url in urls {
      await documentIndex.ingest(contentsOf: url)
    }
  }

  // MARK: - Empty

  @ViewBuilder
  private var empty: some View {
    if model.libraryFiles.isEmpty {
      JunoMobileComposedEmpty(
        String(localized: "No files yet"),
        message: String(localized: "Upload files here. Files you share in chats are kept here too.")
      ) {
        if canUpload {
          Button {
            importIndexes = false
            choosingUpload = true
          } label: {
            JunoMobileCapsuleLabel(String(localized: "Upload files"), icon: .upload)
          }
          .junoMobileCapsulePrimary()
          .contentShape(Capsule())
        }
        if let openConversation {
          Button {
            openConversation("")
          } label: {
            JunoMobileCapsuleLabel(String(localized: "Go to chat"), icon: .newChat)
          }
          .junoMobileCapsuleAction()
          .contentShape(Capsule())
        }
      }
    } else {
      JunoMobileComposedEmpty(
        String(localized: "No matching files"),
        message: String(localized: "Try another name, or clear the filter."),
        mark: .panel
      ) {
        Button {
          searchText = ""
          filter = .all
        } label: {
          JunoMobileCapsuleLabel(String(localized: "Clear filters"), icon: .close)
        }
        .junoMobileCapsuleAction()
        .contentShape(Capsule())
      }
    }
  }

  // MARK: - Actions

  private func open(_ file: NativeProjectFile) {
    Task {
      guard let access = await model.accessFile(id: file.id) else { return }
      do {
        previewURL = try JunoMobileFilePreview.url(for: access, fileName: file.fileName)
      } catch {
        localError = error.localizedDescription
      }
    }
  }

  /// Reads the picked files off the main actor, then hands them to the page
  /// model, which uploads each as its own tile with its own status.
  private func upload(_ urls: [URL]) {
    guard let uploader else { return }
    Task {
      let files = await Task.detached(priority: .userInitiated) {
        urls.compactMap { url -> (data: Data, fileName: String, mimeType: String)? in
          let scoped = url.startAccessingSecurityScopedResource()
          defer { if scoped { url.stopAccessingSecurityScopedResource() } }
          guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else { return nil }
          let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
          return (data, url.lastPathComponent, mime)
        }
      }.value
      uploader.upload(files)
    }
  }
}

// MARK: - Upload tile

/// A file on its way up: its name and a quiet progress line, or what went wrong
/// with Retry and Dismiss. Shaped like the tile it becomes.
private struct JunoMobileLibraryUploadTile: View {
  let upload: NativeLibraryUpload
  let retry: () -> Void
  let dismiss: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ZStack {
        Color.junoSecondary
        switch upload.status {
        case .uploading:
          ProgressView()
            .controlSize(.regular)
        case .failed:
          JunoIconView(.cloudOff, size: 26)
            .foregroundStyle(Color.junoSecondaryInk)
        }
      }
      .aspectRatio(4 / 3, contentMode: .fit)
      .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card - JunoSpace.hairline, style: .continuous))
      VStack(alignment: .leading, spacing: JunoSpace.micro) {
        Text(upload.fileName)
          .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
          .foregroundStyle(Color.junoForeground)
          .lineLimit(1)
          .truncationMode(.middle)
        switch upload.status {
        case .uploading:
          Text("Uploading…")
            .junoFont(size: 12, relativeTo: .caption)
            .foregroundStyle(Color.junoSecondaryInk)
        case let .failed(message, retryable):
          Text(message)
            .junoFont(size: 12, relativeTo: .caption)
            .foregroundStyle(Color.junoDanger)
            .lineLimit(2)
          HStack(spacing: JunoSpace.snug) {
            if retryable {
              Button("Retry", action: retry).contentShape(.rect)
            }
            Button("Dismiss", action: dismiss).contentShape(.rect)
          }
          .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
          .buttonStyle(.borderless)
        }
      }
      .padding(.horizontal, JunoSpace.snug)
      .padding(.top, JunoSpace.snug)
      .padding(.bottom, JunoSpace.tight)
    }
    .padding(JunoSpace.hairline)
    .background(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .fill(Color.junoCard)
    )
    .overlay(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .strokeBorder(Color.junoBorder, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
    )
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Recently deleted

/// Recently deleted, as a page of its own (the web's `/library?deleted=1`):
/// what you removed, each with Restore. A file a chat or project uses was only
/// taken out of the Library; one nothing used was deleted — both land here.
struct JunoMobileLibraryDeletedView: View {
  let client: NativeLibraryClient
  let accountID: AccountID
  /// Something came back: the Library re-syncs so it lands in the grid.
  let restored: () -> Void

  @State private var model: NativeLibraryPageModel?
  @State private var headingPassed = false

  private var items: [NativeLibraryItem] { model?.items ?? [] }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: JunoSpace.section) {
        JunoMobileSerifHeading(
          String(localized: "Recently deleted"),
          lede: String(localized: "Files you remove land here and can be restored. Chats and projects keep the ones they use.")
        )
        if model?.items == nil, model?.failed != true {
          JunoMobileQuietLoading()
            .frame(maxWidth: .infinity, minHeight: JunoSpace.vast * 3)
        } else if model?.failed == true, items.isEmpty {
          JunoMobileComposedEmpty(
            String(localized: "Couldn’t load Recently deleted"),
            message: String(localized: "Check your connection and try again.")
          ) {
            Button {
              Task { await model?.reload() }
            } label: {
              JunoMobileCapsuleLabel(String(localized: "Try again"), icon: .refresh)
            }
            .junoMobileCapsuleAction()
            .contentShape(Capsule())
          }
        } else if items.isEmpty {
          JunoMobileComposedEmpty(
            String(localized: "Nothing in Recently deleted"),
            message: String(localized: "When you remove a file from your Library, it waits here in case you want it back.")
          )
        } else {
          VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
              if index > 0 {
                Divider().padding(.leading, JunoLayout.touchTarget + JunoSpace.cozy + JunoSpace.cozy)
              }
              row(item)
            }
          }
          .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
              .fill(Color.junoCard)
          )
          .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
              .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
          )
        }
      }
      .padding(.horizontal, JunoLayout.Page.gutter)
      .padding(.top, JunoSpace.snug)
      .padding(.bottom, JunoSpace.vast)
      .frame(maxWidth: JunoMobileProjectPageMetrics.measure + JunoLayout.Page.gutter * 2)
      .frame(maxWidth: .infinity)
    }
    .junoMobileTracksHeading($headingPassed, threshold: JunoSpace.vast + JunoSpace.cozy)
    .refreshable { await model?.reload() }
    .background(Color.junoCanvas.ignoresSafeArea())
    .junoMobileSerifTitle(String(localized: "Recently deleted"), revealed: headingPassed)
    .accessibilityIdentifier("juno.mobile.library-deleted")
    .task {
      guard model == nil else { return }
      let page = NativeLibraryPageModel(client: client)
      page.start(for: accountID)
      page.setDeleted(true)
      model = page
      await page.reload()
    }
  }

  private func row(_ item: NativeLibraryItem) -> some View {
    HStack(spacing: JunoSpace.cozy) {
      JunoMobileFileRowLabel(
        request: NativeFilePreviewRequest(item),
        state: .unavailable,
        date: item.deletedAt,
        note: nil
      )
      Button {
        Task {
          await model?.restore([item])
          restored()
        }
      } label: {
        JunoMobileCapsuleLabel(String(localized: "Restore"), icon: .restore)
      }
      .junoMobileCapsuleAction(.small)
      .contentShape(Capsule())
      .accessibilityLabel("Restore \(item.fileName)")
    }
    .padding(.horizontal, JunoSpace.cozy)
  }
}

/// "Now", "2 min", "3 hr", "Yesterday", "Tuesday", "12 Sep", "12 Sep 2024" —
/// the short relative stamps Mail and Messages use. Shared by the workspace
/// lists so every row reads its date the same way.
enum JunoMobileRelativeDate {
    static func text(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return String(localized: "Now") }
        if seconds < 3_600 {
            return Duration.seconds(seconds).formatted(.units(allowed: [.minutes], width: .abbreviated))
        }
        if calendar.isDateInToday(date) {
            return Duration.seconds(seconds).formatted(.units(allowed: [.hours], width: .abbreviated))
        }
        if calendar.isDateInYesterday(date) { return String(localized: "Yesterday") }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return date.formatted(.dateTime.weekday(.wide))
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.day().month(.abbreviated))
        }
        return date.formatted(.dateTime.day().month(.abbreviated).year())
    }
}


// MARK: - Removal

/// The words on a card's destructive action.
///
/// The server keeps a file that a chat or project uses, and deletes a file
/// nothing uses. So what the action does depends on the file, and the menu
/// says which before the tap.
struct JunoLibraryRemovalLabel: Equatable {
    let title: String
    let detail: String?

    init(_ use: NativeLibraryUse?) {
        switch use {
        case .chat:
            title = String(localized: "library.remove")
            detail = String(localized: "library.remove.kept-in-chat")
        case .project:
            title = String(localized: "library.remove")
            detail = String(localized: "library.remove.kept-in-project")
        case nil:
            title = String(localized: "Delete")
            detail = nil
        }
    }
}

// MARK: - Filtering

/// What the library is showing.
enum JunoLibraryFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case images
    case documents

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .all: "library.filter.all"
        case .images: "library.filter.images"
        case .documents: "library.filter.documents"
        }
    }

    func matches(_ file: NativeProjectFile) -> Bool {
        switch self {
        case .all: true
        case .images: file.kind == "IMAGE"
        case .documents: file.kind != "IMAGE"
        }
    }

    /// The screen's whole selection rule, as one pure function so the filter,
    /// the search and the ordering can be tested without a screen.
    static func apply(
        _ files: [NativeProjectFile],
        filter: JunoLibraryFilter,
        search: String,
        sort: JunoLibrarySort
    ) -> [NativeProjectFile] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return files
            .filter { filter.matches($0) }
            .filter { query.isEmpty || $0.fileName.localizedCaseInsensitiveContains(query) }
            .sorted(by: sort.areInOrder)
    }
}

enum JunoLibrarySort: String, CaseIterable, Identifiable, Sendable {
    case newest
    case name

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .newest: "library.sort.newest"
        case .name: "library.sort.name"
        }
    }

    func areInOrder(_ lhs: NativeProjectFile, _ rhs: NativeProjectFile) -> Bool {
        switch self {
        case .newest:
            // Ties broken by name so the order is stable across reloads rather
            // than reshuffling files uploaded in the same second.
            lhs.createdAt == rhs.createdAt
                ? lhs.fileName.localizedCompare(rhs.fileName) == .orderedAscending
                : lhs.createdAt > rhs.createdAt
        case .name:
            lhs.fileName.localizedCompare(rhs.fileName) == .orderedAscending
        }
    }
}
