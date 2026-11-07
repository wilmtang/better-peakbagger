// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { photoToolPreferences as ToolPreferences } from '../src/photos/photo-tool-preferences.js';
import { photoProject as Project } from '../src/photos/photo-project.js';
import { photoRenderer as Renderer } from '../src/photos/photo-renderer.js';
import { photoLibrary as Library } from '../src/photos/photo-library.js';
import { createPhotoBackupStatus, formatPhotoBackupStatus } from '../src/photos/photo-backup-status.js';
import { photoStore as Store } from '../src/photos/photo-store.js';
import { photoArchive as Archive } from '../src/photos/photo-archive.js';
import { imgbbClient as ImgbbClient } from '../src/photos/imgbb-client.js';
import { photoReportSize as ReportSize } from '../src/photos/photo-report-size.js';
import { reportPhoto as PendingPhoto } from '../src/photos/report-photo.js';
import { photoUploadTransaction as UploadTransaction } from '../src/photos/photo-upload-transaction.js';
import { settings as Settings } from '../src/settings/settings.js';
import { listFocusRestorer } from '../src/ui/list-focus.js';
import { readPhotoSourceUrl } from '../src/photos/photo-source-url.js';
import { photoOutput as Output } from '../src/photos/photo-output.ts';
import type { Emphasis, FinishContext } from '../src/photos/photo-output.ts';

type TopoPoint = [number, number];
// The project cleaner infers a union per object type. The page reads whichever
// fields apply after checking `type`, so it uses this flattened view of a clean object.
interface TopoObject {
    id: string; type: string; z: number; text: string; pitch: number;
    geometry: { points: TopoPoint[]; controls: ({ in: TopoPoint | null; out: TopoPoint | null } | null)[]; x: number; y: number; rotation: number; width: number | null };
    style: { color: string; opacity: number; width: number; stroke: string; end: string; smooth: boolean; scale: number; align: string; background: boolean };
}
type TopoProject = Omit<NonNullable<ReturnType<typeof Project.cleanProject>>, 'objects'> & { objects: TopoObject[] };
interface RouteSession { id: string; baseline: TopoProject; points: TopoPoint[]; cursor: TopoPoint | null; historyPushed: boolean; historyBefore: TopoProject[]; futureBefore: TopoProject[]; removedPoints: TopoPoint[]; lastPress: { x: number; y: number; at: number } | null }
interface DragSession { start: TopoPoint; baseline: TopoProject; object: TopoObject; vertex: number | null; resize: { side: string; width: number } | null; pointerId: number; moved: boolean; preview?: TopoProject }
interface DrawingSession { pointerId: number; points: TopoPoint[]; style: TopoObject['style']; preview: SVGElement | null; limit: number }
interface PanSession { pointerId: number; x: number; y: number; startX: number; startY: number }
type TopoRemote = { state: string; url?: string; displayUrl?: string; mediumUrl?: string; viewerUrl?: string; thumbnailUrl?: string };
type TopoPhoto = NonNullable<ReturnType<typeof Library.cleanPhoto>>;
type ToastOptions = { action?: string; onAction?: ((event: MouseEvent & { currentTarget: HTMLButtonElement }) => void) | null; duration?: number };
type ClickHandler = (event: MouseEvent & { currentTarget: HTMLButtonElement }) => void;
type LibraryOperation = (control: HTMLButtonElement) => Promise<unknown>;
type UpdateOptions = { coalesce?: string | null; pushHistory?: boolean; persist?: boolean };
type PhotoStore = Awaited<ReturnType<typeof Store.createPhotoStore>>;
type EncodedExport = Awaited<ReturnType<typeof Renderer.estimateProject>>;
type Timer = ReturnType<typeof setTimeout>;
type PhotoBundle = NonNullable<Awaited<ReturnType<PhotoStore['getBundle']>>>;
type PhotoOperation = { operationId: string; localId: string; state: string; export: object; returnToken: string | null; displayWidth: number | null; updatedAt: string; remote?: TopoRemote; deleteUrl?: unknown };

const ext = globalThis.browser || globalThis.chrome;
const SVG_NS = 'http://www.w3.org/2000/svg';
const LOCAL_PHOTO_ID = new URL(location.href).searchParams.get('localPhotoId') || '';
const canEditReportPhoto = (item: TopoPhoto) => !LOCAL_PHOTO_ID || item.localId === LOCAL_PHOTO_ID
    || item.remote.state === 'draft' && item.lineage?.parentLocalId === LOCAL_PHOTO_ID;
const SOURCE_IMAGE_URL = new URL(location.href).searchParams.get('imageUrl') || '';
const SOURCE_IMAGE_ALT = (new URL(location.href).searchParams.get('imageAlt') || '').slice(0, Library.ALT_LIMIT);
const SOURCE_IMAGE_CAPTION = new URL(location.href).searchParams.get('imageCaption');
let localPhotoReturned = false;
const RETURN_TOKEN = new URL(location.href).searchParams.get('returnToken') || '';
const START_MODE = new URL(location.href).searchParams.get('mode') === 'library' ? 'library' : 'edit';
const IMGBB_PERMISSION = { origins: ['https://api.imgbb.com/*'] };
const FINISH_CONTEXT: FinishContext = LOCAL_PHOTO_ID ? 'local'
    : RETURN_TOKEN ? (SOURCE_IMAGE_URL ? 'report-replace' : 'report-insert') : 'standalone';
const HISTORY_LIMIT = 100;
// Once ImgBB holds a URL the local copy is no longer the editable source of
// truth; changing it in place would silently diverge from the published image.
const PUBLISHED_STATES = ['uploaded', 'unreachable'];
const AUTOSAVE_DELAY_MS = 500;
const EXPORT_ESTIMATE_DELAY_MS = 300;
const GITHUB_CAMO_PREVIEW_BYTES = 5 * 1024 * 1024;
const RECENTLY_DELETED_MS = Library.DELETED_EDITING_RECOVERY_MS;
const LIBRARY_PAGE_SIZE = 48;
const LIBRARY_SEARCH_DELAY_MS = 180;
const LIBRARY_MAINTENANCE_DELAY_MS = 1000;
const LIBRARY_MAINTENANCE_RETRY_MS = 1000;
const LIBRARY_MAINTENANCE_BATCH = 20;
// Source bytes have a different cost and lifecycle from the smaller flattened
// upload and the 40 MiB project archive. Web Crypto has no incremental digest,
// so hashing may materialize the complete encoded file beside the decoded
// bitmap. Bound that allocation independently and leave room for the thumbnail
// and project in the origin's IndexedDB quota estimate.
const MAX_ENCODED_SOURCE_BYTES = 128 * 1024 * 1024;
const SOURCE_STORAGE_HEADROOM_BYTES = 8 * 1024 * 1024;
const IMAGE_LIMIT_MESSAGE = 'That image is too large to edit safely. '
    + 'Use an image no larger than 16,384 px per side and 64 megapixels.';
const DIMENSION_MISMATCH_MESSAGE = 'That project’s dimensions do not match its image.';

const byId = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const ui = {
    credentialForm: byId('credential-form'),
    imgbbDialog: byId<HTMLDialogElement>('imgbb-dialog'),
    imgbbForm: byId('imgbb-dialog').querySelector('form')!,
    imgbbClose: byId<HTMLButtonElement>('imgbb-close'),
    imgbbCancel: byId<HTMLButtonElement>('imgbb-cancel'),
    imgbbError: byId('imgbb-error'),
    imgbbReportHint: byId('imgbb-report-hint'),
    key: byId<HTMLInputElement>('imgbb-key'),
    rememberKey: byId<HTMLInputElement>('remember-key'),
    saveKey: byId<HTMLButtonElement>('save-key'),
    newPhoto: byId<HTMLButtonElement>('new-photo'),
    finishActions: byId('finish-actions'),
    finishStatus: byId('finish-status'),
    copyImage: byId<HTMLButtonElement>('copy-image'),
    exportImage: byId<HTMLButtonElement>('export-image'),
    finishNote: byId('finish-note'),
    finishNoteText: byId('finish-note-text'),
    forgetKey: byId<HTMLButtonElement>('forget-key'),
    outputSummary: byId<HTMLButtonElement>('output-summary'),
    resumeDraft: byId('resume-draft'),
    resumeDraftOpen: byId<HTMLButtonElement>('resume-draft-open'),
    resumeDraftAge: byId('resume-draft-age'),
    resumeDraftAll: byId<HTMLButtonElement>('resume-draft-all'),
    showEditor: byId<HTMLButtonElement>('show-editor'),
    showLibrary: byId<HTMLButtonElement>('show-library'),
    editorView: byId('editor-view'),
    libraryView: byId('library-view'),
    editorEmpty: byId('editor-empty'),
    editorWorkspace: byId('editor-workspace'),
    file: byId<HTMLInputElement>('photo-file'),
    title: byId<HTMLInputElement>('photo-title'),
    caption: byId<HTMLInputElement>('photo-caption'),
    undo: byId<HTMLButtonElement>('undo'),
    redo: byId<HTMLButtonElement>('redo'),
    viewport: byId('photo-viewport'),
    zoom: byId<HTMLSelectElement>('photo-zoom'),
    zoomCustom: byId<HTMLOptionElement>('zoom-custom'),
    zoomIn: byId<HTMLButtonElement>('zoom-in'),
    zoomOut: byId<HTMLButtonElement>('zoom-out'),
    fit: byId<HTMLButtonElement>('fit-photo'),
    pan: byId<HTMLButtonElement>('pan-photo'),
    viewportWidth: byId<HTMLInputElement>('viewport-width'),
    viewportHeight: byId<HTMLInputElement>('viewport-height'),
    resetViewport: byId<HTMLButtonElement>('reset-viewport'),
    stage: byId('photo-stage'),
    sourceImage: byId<HTMLImageElement>('source-image'),
    overlay: byId<SVGSVGElement>('photo-overlay'),
    finishRoute: byId<HTMLButtonElement>('finish-route'),
    editorStatus: byId('editor-status'),
    addAtCenter: byId<HTMLButtonElement>('add-at-center'),
    annotationEmpty: byId('annotation-empty'),
    annotationList: byId('annotation-list'),
    routePoints: byId('route-points'),
    routePointList: byId('route-point-list'),
    insertRoutePoint: byId<HTMLButtonElement>('insert-route-point'),
    removeRoutePoint: byId<HTMLButtonElement>('remove-route-point'),
    inspector: byId('inspector'),
    inspectorHeading: byId('inspector-heading'),
    objectActions: byId('object-actions'),
    color: byId<HTMLSelectElement>('object-color'),
    opacity: byId<HTMLInputElement>('object-opacity'),
    opacityValue: byId<HTMLOutputElement>('object-opacity-value'),
    routeWidth: byId<HTMLInputElement>('route-width'),
    routeWidthValue: byId<HTMLOutputElement>('route-width-value'),
    routeStroke: byId<HTMLSelectElement>('route-stroke'),
    routeArrow: byId<HTMLInputElement>('route-arrow'),
    routeSmooth: byId<HTMLInputElement>('route-smooth'),
    scale: byId<HTMLInputElement>('object-scale'),
    scaleValue: byId<HTMLOutputElement>('object-scale-value'),
    rotation: byId<HTMLInputElement>('object-rotation'),
    rotationValue: byId<HTMLOutputElement>('object-rotation-value'),
    pitch: byId<HTMLSelectElement>('pitch-number'),
    text: byId<HTMLTextAreaElement>('object-text'),
    textEditor: byId('photo-text-editor'),
    textWidth: byId<HTMLInputElement>('text-width'),
    textWidthAuto: byId<HTMLButtonElement>('text-width-auto'),
    align: byId<HTMLSelectElement>('text-align'),
    background: byId<HTMLInputElement>('label-background'),
    sendBack: byId<HTMLButtonElement>('send-back'),
    bringFront: byId<HTMLButtonElement>('bring-front'),
    duplicate: byId<HTMLButtonElement>('duplicate-object'),
    deleteObject: byId<HTMLButtonElement>('delete-object'),
    clear: byId<HTMLButtonElement>('clear-annotations'),
    upload: byId<HTMLButtonElement>('upload-insert'),
    exportSummary: byId('export-summary'),
    saveStatus: byId('save-status'),
    saveConflictedDraft: byId<HTMLButtonElement>('save-conflicted-draft'),
    uploadFormat: byId<HTMLSelectElement>('upload-format'),
    originalFormat: byId<HTMLOptionElement>('upload-format-original'),
    jpegQualityControl: byId('jpeg-quality-control'),
    jpegQuality: byId<HTMLInputElement>('jpeg-quality'),
    jpegQualityValue: byId<HTMLOutputElement>('jpeg-quality-value'),
    uploadEstimate: byId('upload-estimate'),
    uploadEstimateNote: byId('upload-estimate-note'),
    search: byId<HTMLInputElement>('library-search'),
    filter: byId<HTMLSelectElement>('library-filter'),
    importProject: byId<HTMLInputElement>('import-project'),
    libraryList: byId('library-list'),
    libraryPagination: byId('library-pagination'),
    libraryPrevious: byId<HTMLButtonElement>('library-previous'),
    libraryPageStatus: byId('library-page-status'),
    libraryNext: byId<HTMLButtonElement>('library-next'),
    libraryEmpty: byId('library-empty'),
    storageSummary: byId('storage-summary'),
    backupStatus: byId('photo-backup-status'),
    backupNow: byId<HTMLButtonElement>('backup-library'),
    reportWidthControls: [...document.querySelectorAll<HTMLElement>('[data-report-width-control]')],
    reportWidthSelects: [...document.querySelectorAll<HTMLSelectElement>('[data-report-width]')],
    toast: byId('toast'),
    toastMessage: byId('toast-message'),
    toastAction: byId<HTMLButtonElement>('toast-action'),
    toastCopyValue: byId<HTMLInputElement>('toast-copy-value'),
    toastCopyStatus: byId('toast-copy-status'),
};

const send = async (message: object) => {
    try { return await ext.runtime.sendMessage(message); }
    catch { return null; }
};

const element = <T extends HTMLElement = HTMLElement>(tag: string, className = '', text: string | null = '') => {
    const node = document.createElement(tag) as T;
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
};

let store: PhotoStore;
let project: TopoProject | null = null;
let photo: TopoPhoto | null = null;
let originalBlob: Blob | null = null;
let thumbnailBlob: Blob | null = null;
let sourceBitmap: ImageBitmap | null = null;
let sourceUrl: string | null = null;
let selectedId: string | null = null;
let selectedVertex: number | null = null;
let activeTool = 'select';
let routeSession: RouteSession | null = null;
let dragSession: DragSession | null = null;
let drawingSession: DrawingSession | null = null;
let history: TopoProject[] = [];
let future: TopoProject[] = [];
let autosaveTimer: Timer | null = null;
let draftRevision = 0;
let draftDirty = false;
let draftWriteQueue = Promise.resolve(true);
let replacingOtherTab = false;
let teardownStarted = false;
let sessionKey = '';
// A key typed into the upload dialog is held here until ImgBB has seen it, so
// a typo never becomes the saved key and a request that never left the page
// does not throw the key away either.
let pendingKey: { value: string; remember: boolean } | null = null;
let pendingKeyReachedProvider = false;
// The report's one-time return token is spent by a confirmed insertion.
let insertionConfirmed = false;
const outputBusy = { copy: false, export: false };
let outputEncode: { key: string; promise: Promise<EncodedExport> } | null = null;
let copyResetTimer: Timer | null = null;
let emptyStateRevealed = false;
let uploadInFlight = false;
// Each Connect click gets a token, so a permission answer that arrives after
// the dialog was cancelled or resubmitted cannot start an upload.
let keySubmission = 0;
let insertedLocalId: string | null = null;
let configuredKey = false;
let permissionGranted = false;
let busy = false;
let storeReloadRequired = false;
let toastTimer: Timer | null = null;
let toastGeneration = 0;
let toastBaseMessage = '';
let undoDeleted: TopoPhoto | null = null;
let reportImageWidth: number | null = Settings.DEFAULTS.reportImageWidth;
let unsubscribeSettings = () => {};
let ascentBackupEnabled = Settings.DEFAULTS.enableGithubBackup;
let uploadFormat = 'original';
let jpegQuality = Project.DEFAULT_JPEG_QUALITY;
let exportRevision = 0;
let exportEstimateTimer: Timer | null = null;
let cachedExport: { revision: number; encoded: EncodedExport } | null = null;
let exportEstimateJob: { revision: number; source: ImageBitmap; promise: Promise<EncodedExport> } | null = null;
let exportEstimatePending = false;
let photoDragDepth = 0;

let camera = { fit: true, scale: 1, x: 0, y: 0 };
let handMode = false;
let spacePan = false;
let panSession: PanSession | null = null;
let viewportSize: { width: number | null; height: number | null } = { width: null, height: null };
const VIEWPORT_KEY = 'bpbPhotoViewport';
const viewportBounds = () => ({
    width: ui.viewport.clientWidth || 1148,
    height: ui.viewport.clientHeight || 873,
});
const applyReportWidthPreview = () => {
    if (!project) return;
    const bounds = viewportBounds();
    const style = getComputedStyle(ui.viewport);
    const availableWidth = bounds.width
        - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const availableHeight = bounds.height
        - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
    if (camera.fit) {
        const reportWidth = RETURN_TOKEN
            ? ReportSize.displayWidth(project.image.width, reportImageWidth) ?? project.image.width
            : 1100;
        camera.scale = Math.min(availableWidth, 1100, reportWidth,
            availableHeight * project.image.width / project.image.height) / project.image.width;
        camera.x = 0;
        camera.y = 0;
    }
    const width = project.image.width * camera.scale;
    const height = project.image.height * camera.scale;
    // Keep at least a portion of the photo reachable after panning or resizing.
    const maxX = Math.max(0, (width + bounds.width) / 2 - 48);
    const maxY = Math.max(0, (height + bounds.height) / 2 - 48);
    camera.x = Math.max(-maxX, Math.min(maxX, camera.x));
    camera.y = Math.max(-maxY, Math.min(maxY, camera.y));
    ui.stage.style.width = `${width}px`;
    ui.stage.style.maxWidth = `${width}px`;
    ui.stage.style.transform = `translate(${(bounds.width - width) / 2 + camera.x}px, ${(bounds.height - height) / 2 + camera.y}px)`;
    const token = String(camera.scale);
    const exact = [...ui.zoom.options].some(option => option.value === token);
    ui.zoomCustom.textContent = `${Math.round(camera.scale * 100)}%`;
    ui.zoomCustom.hidden = camera.fit || exact;
    ui.zoom.value = camera.fit ? 'fit' : exact ? token : 'custom';
    ui.zoomIn.disabled = camera.scale >= 8;
    ui.zoomOut.disabled = camera.scale <= 0.01;
    ui.overlay.querySelectorAll<HTMLElement>('.text-width-handle').forEach(handle => {
        handle.setAttribute('r', String(6 / camera.scale));
    });
};
const zoomPhoto = (scale: number, anchor: { x: number; y: number } | null = null) => {
    if (!project || drawingSession || dragSession || panSession) return;
    const next = Math.min(8, Math.max(0.01, scale));
    const bounds = viewportBounds();
    const at = anchor || { x: bounds.width / 2, y: bounds.height / 2 };
    const ratio = next / camera.scale;
    camera.x = at.x - bounds.width / 2 - (at.x - bounds.width / 2 - camera.x) * ratio;
    camera.y = at.y - bounds.height / 2 - (at.y - bounds.height / 2 - camera.y) * ratio;
    camera.fit = false;
    camera.scale = next;
    applyReportWidthPreview();
};
const fitPhoto = () => {
    if (drawingSession || dragSession || panSession) return;
    camera.fit = true;
    applyReportWidthPreview();
};
const updatePanCursor = () => {
    ui.pan.setAttribute('aria-pressed', String(handMode));
    ui.viewport.classList.toggle('can-pan', handMode || spacePan);
    ui.viewport.classList.toggle('is-panning', !!panSession);
};
const endPan = () => {
    const pointerId = panSession?.pointerId as number;
    panSession = null;
    if (ui.viewport.hasPointerCapture?.(pointerId)) ui.viewport.releasePointerCapture(pointerId);
    updatePanCursor();
};
const applyViewportSize = () => {
    const sidebars = window.innerWidth > 900 ? 374 : 0;
    ui.editorWorkspace.style.width = viewportSize.width ? `${viewportSize.width + sidebars + 2}px` : '';
    if (viewportSize.height) ui.editorWorkspace.style.setProperty('--photo-viewport-height', `${viewportSize.height}px`);
    else ui.editorWorkspace.style.removeProperty('--photo-viewport-height');
    ui.viewportWidth.value = (viewportSize.width ?? '') as string;
    ui.viewportHeight.value = (viewportSize.height ?? '') as string;
    applyReportWidthPreview();
};
const cleanViewportDimension = (value: number, min: number, max: number) =>
    Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : null;
const saveViewportSize = () => {
    applyViewportSize();
    const saved = { ...viewportSize };
    preferenceWrites = preferenceWrites.then(() => ext.storage.local.set({ [VIEWPORT_KEY]: saved }))
        .catch(() => toast('Viewport size applies now, but could not be saved on this device.'));
};

const setReportImageWidth = (width: number | null) => {
    const choice = ReportSize.choiceFromToken(ReportSize.tokenFromWidth(width));
    reportImageWidth = choice ? choice.width : Settings.DEFAULTS.reportImageWidth;
    for (const select of ui.reportWidthSelects) {
        select.value = choice?.token || ReportSize.tokenFromWidth(Settings.DEFAULTS.reportImageWidth);
    }
    applyReportWidthPreview();
    if (cachedExport) renderOutputSummary('ready');
};

const paintReportWidthControls = () => {
    for (const select of ui.reportWidthSelects) {
        select.replaceChildren(...ReportSize.CHOICES.map(choice => {
            const option = element<HTMLOptionElement>('option', '', choice.label);
            option.value = choice.token;
            return option;
        }));
    }
    for (const control of ui.reportWidthControls) control.hidden = !RETURN_TOKEN || !!LOCAL_PHOTO_ID;
    setReportImageWidth(reportImageWidth);
};

const chooseReportImageWidth = async (event: Event) => {
    if (busy) return;
    const choice = ReportSize.choiceFromToken((event.currentTarget as HTMLSelectElement).value);
    if (!choice) return;
    setReportImageWidth(choice.width);
    try {
        const saved = await Settings.set({ reportImageWidth: choice.width });
        setReportImageWidth(saved.reportImageWidth);
    } catch {
        toast('This size applies now, but could not be remembered for the next report photo.');
    }
};
let libraryObjectUrls: string[] = [];
let libraryRender = Promise.resolve();
let libraryRenderQueued = false;
let libraryPage = 0;
let librarySearchTimer: Timer | null = null;
let libraryMaintenanceTimer: Timer | null = null;
let libraryMaintenanceRunning = false;
let libraryMaintenanceSuspended = false;
let libraryMaintenanceFailure: { at: string; message: string } | null = null;
let photoBackupBusy = false;
let newVersionTransaction: object | null = null;
// Color and opacity are shared; other preferences belong to their tool.
// Project history never rewinds these choices.
const toolPreferences = Object.fromEntries(Project.OBJECT_TYPES.map(type =>
    [type, ToolPreferences.clean(type)]));
const preferenceKey = (type: string) => `bpbPhotoTool:${type}`;
const SHARED_STYLE_KEY = 'bpbPhotoSharedStyle';
let preferenceWrites: Promise<unknown> = Promise.resolve();
const rememberTool = (type: string, patch: { style?: Partial<TopoObject['style']>; rotation?: number }) => {
    toolPreferences[type] = ToolPreferences.clean(type, {
        ...toolPreferences[type], ...patch,
        style: { ...toolPreferences[type]!.style, ...patch.style },
    });
    const shared = {};
    for (const key of ['color', 'opacity']) {
        if (Object.hasOwn(patch.style || {}, key)) (shared as Record<string, unknown>)[key] = (toolPreferences[type]!.style as Record<string, unknown>)[key];
    }
    for (const preferences of Object.values(toolPreferences)) Object.assign(preferences!.style, shared);
    const { color, opacity } = toolPreferences[type]!.style;
    const saved = structuredClone({
        [preferenceKey(type)]: toolPreferences[type],
        ...(Object.keys(shared).length ? { [SHARED_STYLE_KEY]: { color, opacity } } : {}),
    });
    preferenceWrites = preferenceWrites.then(() => Settings.set(saved))
        .catch(() => toast('Tool settings apply now, but could not be remembered.'));
};
const loadToolPreferences = async () => {
    try {
        const [preferences, local] = await Promise.all([Settings.preferences([...Project.OBJECT_TYPES.map(preferenceKey), SHARED_STYLE_KEY]), ext.storage.local.get(VIEWPORT_KEY)]);
        const stored = { ...preferences, ...local } as unknown as Record<string, { width: number; height: number } | undefined>;
        viewportSize = {
            width: cleanViewportDimension(stored[VIEWPORT_KEY]?.width as number, 280, 2400),
            height: cleanViewportDimension(stored[VIEWPORT_KEY]?.height as number, 240, 1400),
        };
        applyViewportSize();
        for (const type of Project.OBJECT_TYPES) {
            toolPreferences[type] = ToolPreferences.clean(type, stored[preferenceKey(type)]);
            if (stored[SHARED_STYLE_KEY]) {
                const shared = ToolPreferences.clean(type, { style: stored[SHARED_STYLE_KEY] })!.style;
                Object.assign(toolPreferences[type]!.style, { color: shared.color, opacity: shared.opacity });
            }
        }
    } catch { /* Defaults remain usable when local storage is unavailable. */ }
};

const setEditorStatus = (message: string) => { ui.editorStatus.textContent = message; };
const setSaveStatus = (message: string) => { ui.saveStatus.textContent = message; };
const notifyBackupChanged = () => { void send({ type: 'GITHUB_PHOTOS_CHANGED' }); };

const resetToastCopy = () => {
    ui.toastCopyValue.hidden = true;
    ui.toastCopyValue.value = '';
    ui.toastCopyStatus.hidden = true;
    ui.toastCopyStatus.textContent = '';
};

const dismissToast = (generation = toastGeneration) => {
    if (generation !== toastGeneration) return;
    clearTimeout(toastTimer!);
    toastGeneration += 1;
    ui.toast.hidden = true;
    ui.toastAction.hidden = true;
    ui.toastAction.disabled = false;
    ui.toastAction.onclick = null;
    resetToastCopy();
};

const toast = (message: string, { action = '', onAction = null, duration = 5000 }: ToastOptions = {}) => {
    clearTimeout(toastTimer!);
    const generation = ++toastGeneration;
    toastBaseMessage = message;
    ui.toastMessage.textContent = message;
    ui.toastAction.hidden = !action;
    ui.toastAction.disabled = false;
    const label = document.createElement('span'); label.textContent = action;
    ui.toastAction.replaceChildren(label);
    ui.toastAction.dataset.sizingLabel = /copy/i.test(action) ? 'Try copy again' : action;
    ui.toastAction.onclick = onAction as typeof ui.toastAction.onclick;
    resetToastCopy();
    ui.toast.hidden = false;
    if (duration) toastTimer = setTimeout(() => dismissToast(generation), duration);
    return generation;
};

const ownsToast = (generation: number) => generation === toastGeneration && !ui.toast.hidden;

const showToastCopyValue = (text: string, generation: number, { select = false } = {}) => {
    if (!ownsToast(generation)) return false;
    ui.toastCopyValue.value = text;
    ui.toastCopyValue.hidden = false;
    if (select) {
        try { ui.toastCopyValue.focus({ preventScroll: true }); }
        catch { ui.toastCopyValue.focus(); }
        ui.toastCopyValue.select();
        ui.toastCopyValue.setSelectionRange(0, text.length);
    }
    return true;
};

const copyTextWithFallback = async (text: string, {
    ownerGeneration = null,
    control = null,
    keepVisible = false,
}: { ownerGeneration?: number | null; control?: HTMLButtonElement | null; keepVisible?: boolean } = {}) => {
    const generation = ownerGeneration ?? toast('Copying image URL…', { duration: 0 });
    if (!ownsToast(generation) || (control && !control.isConnected)) return false;
    if (control) control.disabled = true;
    if (keepVisible) {
        ui.toastMessage.textContent = toastBaseMessage;
        showToastCopyValue(text, generation);
    }
    ui.toastCopyStatus.hidden = true;
    ui.toastCopyStatus.textContent = '';
    try {
        const clipboard = navigator.clipboard;
        if (!clipboard || typeof clipboard.writeText !== 'function') {
            throw new Error('Clipboard API unavailable');
        }
        await clipboard.writeText(text);
        if (!ownsToast(generation) || (control && !control.isConnected)) return false;
        if (keepVisible) {
            ui.toastCopyStatus.textContent = 'Image URL copied.';
            ui.toastCopyStatus.hidden = false;
            if (control) (control.querySelector('span') || control).textContent = 'Copy again';
        } else {
            toast('Image URL copied.');
        }
        return true;
    } catch {
        if (!ownsToast(generation) || (control && !control.isConnected)) return false;
        ui.toastMessage.textContent = keepVisible
            ? `${toastBaseMessage} Copy unavailable.`
            : 'Copy unavailable.';
        ui.toastCopyStatus.textContent = 'The complete URL is selected; press Ctrl/Cmd+C.';
        ui.toastCopyStatus.hidden = false;
        showToastCopyValue(text, generation, { select: true });
        if (control) (control.querySelector('span') || control).textContent = 'Try copy again';
        return false;
    } finally {
        if (control?.isConnected && (ownerGeneration == null || ownsToast(generation))) {
            control.disabled = false;
        }
    }
};

const showUrlRecovery = (message: string, url: string) => {
    const generation = toast(message, {
        action: 'Copy URL',
        onAction: event => void copyTextWithFallback(url, {
            ownerGeneration: generation,
            control: event.currentTarget,
            keepVisible: true,
        }),
        duration: 0,
    });
    showToastCopyValue(url, generation);
};

const setView = (view: string) => {
    if (busy) return;
    const editor = view === 'editor';
    if (!editor) endCoalescing();
    ui.editorView.hidden = !editor;
    ui.libraryView.hidden = editor;
    ui.showEditor.setAttribute('aria-current', editor ? 'page' : 'false');
    ui.showLibrary.setAttribute('aria-current', editor ? 'false' : 'page');
    if (!editor) void renderLibrary();
};

const editorMutationLocked = () => storeReloadRequired || localPhotoReturned || busy
    || PUBLISHED_STATES.includes(photo?.remote.state as string);

const editorMutationControls = () => ([
    ui.title,
    ui.caption,
    ui.finishRoute,
    ui.insertRoutePoint,
    ui.removeRoutePoint,
    ui.color,
    ui.opacity,
    ui.routeWidth,
    ui.routeStroke,
    ui.routeArrow,
    ui.routeSmooth,
    ui.scale,
    ui.rotation,
    ui.pitch,
    ui.text,
    ui.textWidth,
    ui.textWidthAuto,
    ui.align,
    ui.background,
    ui.addAtCenter,
    ui.sendBack,
    ui.bringFront,
    ui.duplicate,
    ui.deleteObject,
    ui.clear,
    ui.uploadFormat,
    ui.jpegQuality,
    ...document.querySelectorAll<HTMLElement>('[data-tool]'),
] as HTMLButtonElement[]);

const updateEditorControls = () => {
    const locked = editorMutationLocked();
    for (const control of editorMutationControls()) control.disabled = locked;
    ui.addAtCenter.disabled = locked || ['select', 'drawing'].includes(activeTool) || !project;
    for (const control of ui.annotationList.querySelectorAll<HTMLButtonElement>('button')) control.disabled = locked;
    for (const control of ui.routePointList.querySelectorAll<HTMLButtonElement>('button')) control.disabled = locked;
    const route = selectedObject();
    ui.insertRoutePoint.disabled = locked || route?.type !== 'route';
    ui.removeRoutePoint.disabled = locked || route?.type !== 'route'
        || selectedVertex == null || route.geometry.points.length <= 2;
    ui.saveConflictedDraft.disabled = storeReloadRequired || busy || localPhotoReturned
        || replacingOtherTab;
    ui.showEditor.disabled = storeReloadRequired || busy;
    ui.showLibrary.disabled = storeReloadRequired || busy;
    ui.file.disabled = storeReloadRequired || busy || !!LOCAL_PHOTO_ID;
    ui.importProject.disabled = storeReloadRequired || busy;
    setAvailable(ui.newPhoto, !storeReloadRequired && !busy);
    for (const select of ui.reportWidthSelects) select.disabled = busy;
    ui.viewport.setAttribute('aria-busy', String(busy));
    ui.overlay.setAttribute('aria-disabled', String(locked));
    updateHistoryButtons();
    renderFinish();
};

const setBusy = (value: boolean, message = '') => {
    busy = value;
    updateEditorControls();
    if (message) setEditorStatus(message);
};

const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const exportMimeLabel = (mime: string) => mime === 'image/png' ? 'PNG' : 'JPEG';
const sourceExportMime = () => Project.sourceExportMime(originalBlob?.type);

const resolvedUploadSettings = () => Project.resolveExportSettings({
    format: uploadFormat,
    sourceMime: originalBlob?.type,
    jpegQuality,
} as never);

const syncUploadControls = () => {
    const originalMime = sourceExportMime();
    if (!originalMime && uploadFormat === 'original') uploadFormat = 'jpeg';
    ui.originalFormat.disabled = !originalMime;
    ui.originalFormat.textContent = originalMime
        ? `Follow original format · ${exportMimeLabel(originalMime)}`
        : 'Follow original format · unavailable';
    ui.uploadFormat.value = uploadFormat;
    const settings = resolvedUploadSettings();
    ui.jpegQualityControl.hidden = settings?.mime !== 'image/jpeg';
    const percent = Math.round(jpegQuality * 100);
    ui.jpegQuality.value = String(percent);
    ui.jpegQualityValue.textContent = `${percent}%`;
};

const cancelExportEstimate = () => {
    exportRevision += 1;
    clearTimeout(exportEstimateTimer!);
    exportEstimateTimer = null;
    cachedExport = null;
    exportEstimatePending = false;
};

const overGithubLimit = () => !!cachedExport && ascentBackupEnabled
    && cachedExport.encoded.bytes > GITHUB_CAMO_PREVIEW_BYTES;

// One line, kept beside the canvas, for the file the finish actions produce:
// the format control itself can be out of view below the photo.
const renderOutputSummary = (state: 'estimating' | 'ready' | 'unavailable') => {
    const parts = [element('span', 'summary-file', state === 'estimating' ? 'Estimating…'
        : state === 'unavailable' ? 'Size unavailable'
            : `${exportMimeLabel(cachedExport!.encoded.mime)} · ${formatBytes(cachedExport!.encoded.bytes)}`)];
    if (RETURN_TOKEN && !LOCAL_PHOTO_ID) {
        const size = reportImageWidth == null ? 'Original' : `${reportImageWidth}`;
        parts.push(element('span', 'summary-report-size', ` · Size in report: ${size}`));
    }
    ui.outputSummary.replaceChildren(...parts);
};

const showExportEstimate = (encoded: EncodedExport) => {
    ui.uploadEstimate.parentElement!.classList.remove('is-warning');
    ui.uploadEstimate.textContent = `${formatBytes(encoded.bytes)} ${exportMimeLabel(encoded.mime)}`;
    ui.uploadEstimateNote.textContent = `${encoded.width} × ${encoded.height} · full resolution · no metadata`;
    renderOutputSummary('ready');
    renderFinish();
};

const applyPhotoSettings = (settings: typeof Settings.DEFAULTS) => {
    ascentBackupEnabled = settings.enableGithubBackup === true;
    if (RETURN_TOKEN) setReportImageWidth(settings.reportImageWidth);
    if (cachedExport?.encoded) showExportEstimate(cachedExport.encoded);
};

// Full-resolution PNG encoding can be expensive. Keep at most one background
// estimate in flight; a later edit replaces the queued work with current state.
const refreshExportEstimate = async (revision: number) => {
    if (exportEstimateJob) {
        exportEstimatePending = true;
        return;
    }
    const estimatingProject = project;
    const estimatingSource = sourceBitmap;
    const job = {
        revision,
        source: estimatingSource!,
        promise: Renderer.estimateProject({
            project: estimatingProject,
            source: estimatingSource,
        } as never) as Promise<EncodedExport>,
    };
    exportEstimateJob = job as NonNullable<typeof exportEstimateJob>;
    try {
        const encoded = await job.promise;
        if (revision !== exportRevision || estimatingSource !== sourceBitmap) return;
        cachedExport = { revision, encoded };
        showExportEstimate(encoded);
    } catch {
        if (revision !== exportRevision) return;
        ui.uploadEstimate.parentElement!.classList.remove('is-warning');
        ui.uploadEstimate.textContent = 'Size unavailable';
        ui.uploadEstimateNote.textContent = 'The image is encoded again when you copy, export, or upload it.';
        renderOutputSummary('unavailable');
    } finally {
        if (exportEstimateJob === job) exportEstimateJob = null;
        if (exportEstimatePending) {
            exportEstimatePending = false;
            if (project && sourceBitmap) void refreshExportEstimate(exportRevision);
        }
    }
};

const invalidateExportEstimate = ({ immediate = false } = {}) => {
    cancelExportEstimate();
    if (!project || !sourceBitmap) {
        ui.uploadEstimate.parentElement!.classList.remove('is-warning');
        ui.uploadEstimate.textContent = 'Choose a photo to estimate';
        ui.uploadEstimateNote.textContent = 'Full resolution · annotations included';
        renderOutputSummary('estimating');
        return;
    }
    const revision = exportRevision;
    ui.uploadEstimate.parentElement!.classList.remove('is-warning');
    ui.uploadEstimate.textContent = 'Estimating size…';
    ui.uploadEstimateNote.textContent = 'Full resolution · annotations included';
    renderOutputSummary('estimating');
    renderFinish();
    exportEstimateTimer = setTimeout(() => {
        exportEstimateTimer = null;
        void refreshExportEstimate(revision);
    }, immediate ? 0 : EXPORT_ESTIMATE_DELAY_MS);
};

const initializeUploadSettings = () => {
    jpegQuality = project?.export.mime === 'image/jpeg'
        ? project.export.quality
        : Project.DEFAULT_JPEG_QUALITY;
    uploadFormat = Project.inferExportFormat(project?.export, originalBlob?.type) || 'jpeg';
    syncUploadControls();
    invalidateExportEstimate({ immediate: true });
};

const applyUploadSettings = ({ persist = true } = {}) => {
    if (editorMutationLocked() || !project) return false;
    const settings = resolvedUploadSettings();
    if (!settings) return false;
    const changed = project.export.mime !== settings.mime
        || project.export.quality !== settings.quality;
    if (changed) {
        const next = Project.cleanProject({ ...project, export: settings });
        if (!next) return false;
        project = next as unknown as TopoProject;
        invalidateExportEstimate();
    }
    syncUploadControls();
    if (persist) schedulePersist();
    return true;
};

const prepareSnapshotExport = async ({ project: exportingProject, sourceBitmap: exportingSource }: { project: TopoProject; sourceBitmap: ImageBitmap | null }) => {
    const revision = exportRevision;
    clearTimeout(exportEstimateTimer!);
    exportEstimateTimer = null;
    let encoded = cachedExport?.revision === revision ? cachedExport.encoded : null;
    if (!encoded
        && exportEstimateJob?.revision === revision
        && exportEstimateJob.source === exportingSource) {
        encoded = await exportEstimateJob.promise;
    }
    if (!encoded) {
        encoded = await Renderer.estimateProject({
            project: exportingProject,
            source: exportingSource,
        } as never);
    }
    if (revision !== exportRevision || exportingSource !== sourceBitmap) {
        throw new Error('The photo changed while it was being prepared.');
    }
    cachedExport = { revision, encoded };
    const sha256 = await Renderer.sha256(encoded.blob);
    if (revision !== exportRevision) throw new Error('The photo changed while it was being prepared.');
    return { ...encoded, sha256 };
};

const keyMode = () => configuredKey ? 'device' as const : sessionKey ? 'tab' as const : 'none' as const;

const setButtonLabel = (button: HTMLButtonElement, label: string) => {
    const span = button.querySelector('span');
    if (span) span.textContent = label;
    else button.textContent = label;
};

const EMPHASIS_CLASSES: Record<Emphasis, string[]> = {
    primary: ['primary', 'primary-button'],
    secondary: ['secondary', 'secondary-button'],
    quiet: ['quiet', 'quiet-button'],
};
const setEmphasis = (button: HTMLButtonElement, emphasis: Emphasis) => {
    for (const [name, classes] of Object.entries(EMPHASIS_CLASSES)) {
        for (const className of classes) button.classList.toggle(className, name === emphasis);
    }
};

// Finish actions stay focusable while unavailable: native disabling would drop
// keyboard focus to the page every time an upload or encode starts.
const setAvailable = (button: HTMLButtonElement, available: boolean) => {
    if (available) button.removeAttribute('aria-disabled');
    else button.setAttribute('aria-disabled', 'true');
};
const unavailable = (button: HTMLButtonElement) => button.getAttribute('aria-disabled') === 'true';

const outputAvailable = () => !!project && !!sourceBitmap && !busy;

const renderFinish = () => {
    const state = Output.finishState({
        context: FINISH_CONTEXT,
        keyMode: keyMode(),
        remoteState: photo?.remote.state ?? null,
        insertionConfirmed: insertionConfirmed && insertedLocalId === photo?.localId,
        localReturned: localPhotoReturned,
        pendingKey: !!pendingKey,
        overGithubLimit: overGithubLimit(),
        uploadInFlight,
    });
    const { slot } = state;
    ui.upload.dataset.kind = slot.kind;
    ui.upload.dataset.sizingLabel = slot.sizingLabel;
    ui.finishStatus.dataset.sizingLabel = slot.sizingLabel;
    setEmphasis(ui.upload, slot.emphasis);
    if (slot.kind === 'status') {
        // Completion replaces the action with a plain status; keep the
        // keyboard user on a neighbouring action rather than on the page.
        if (document.activeElement === ui.upload) {
            (ui.copyImage.hidden ? ui.exportImage : ui.copyImage).focus({ preventScroll: true });
        }
        ui.upload.hidden = true;
        // The label shares one grid cell with the reserved width, as in a button.
        ui.finishStatus.replaceChildren(element('span', '', slot.label));
        ui.finishStatus.hidden = false;
    } else {
        setButtonLabel(ui.upload, slot.label);
        ui.upload.hidden = false;
        ui.finishStatus.hidden = true;
    }
    setAvailable(ui.upload, !storeReloadRequired && !busy && !!project
        && (slot.kind !== 'upload' || !!sourceBitmap));
    setEmphasis(ui.exportImage, state.exportEmphasis);
    setAvailable(ui.copyImage, outputAvailable() && !outputBusy.copy);
    setAvailable(ui.exportImage, outputAvailable() && !outputBusy.export);
    ui.newPhoto.hidden = !!LOCAL_PHOTO_ID || !!SOURCE_IMAGE_URL;
    ui.newPhoto.classList.toggle('is-retired', insertionConfirmed);
    ui.newPhoto.setAttribute('aria-hidden', String(insertionConfirmed));
    ui.finishNote.hidden = !state.note;
    ui.finishNote.dataset.kind = state.note?.kind || '';
    ui.finishNoteText.textContent = state.note?.text || '';
    ui.forgetKey.hidden = state.note?.kind !== 'tab-key';
};

const updateCredentialUi = () => { renderFinish(); };

const refreshCredential = async () => {
    const response = await send({ type: 'PHOTO_IMGBB_STATUS' });
    const nextConfiguredKey = !!response?.ok && !!response.configured;
    // Saving a device key in Settings while this page holds a tab-only key is
    // an explicit replacement. Do not keep leasing the now-hidden session key.
    if (nextConfiguredKey) sessionKey = '';
    configuredKey = nextConfiguredKey;
    permissionGranted = !!response?.ok && !!response.permissionGranted;
    updateCredentialUi();
};

// Firefox accepts permissions.request() only while the click's handler is still
// running: an awaited contains() or storage read first makes it throw. Callers
// that need the prompt request it before anything awaits; this check only
// confirms the grant later in the upload.
const hasPermission = async () => {
    try { permissionGranted = !!await ext.permissions.contains(IMGBB_PERMISSION); }
    catch { permissionGranted = false; }
    return permissionGranted;
};

const requestPermissionInGesture = () => {
    try { return Promise.resolve(ext.permissions.request(IMGBB_PERMISSION)).then(granted => !!granted, () => false); }
    catch { return Promise.resolve(false); }
};

const removeCredential = async () => {
    if (busy) return;
    sessionKey = '';
    updateCredentialUi();
    toast('The key was forgotten for this tab. Existing photos were not changed.');
};

const leaseCredential = async () => {
    if (pendingKey) {
        // A key saved in Settings since the dialog closed wins over the one
        // still waiting here.
        await refreshCredential();
        if (!configuredKey) return pendingKey.value;
        pendingKey = null;
    }
    if (sessionKey) return sessionKey;
    const response = await send({ type: 'PHOTO_IMGBB_LEASE_KEY' });
    return response?.ok ? response.key : null;
};

const dialogError = (message: string) => {
    ui.imgbbError.textContent = message;
    ui.imgbbError.hidden = !message;
};

let dialogReturnFocus: HTMLElement | null = null;
const openKeyDialog = (error = '') => {
    if (ui.imgbbDialog.open) { dialogError(error); return; }
    dialogReturnFocus = ui.upload;
    ui.key.value = '';
    dialogError(error);
    ui.imgbbReportHint.hidden = FINISH_CONTEXT === 'standalone';
    setButtonLabel(ui.saveKey, FINISH_CONTEXT === 'standalone' ? 'Connect and upload'
        : FINISH_CONTEXT === 'report-replace' ? 'Connect and replace' : 'Connect and insert');
    ui.saveKey.dataset.sizingLabel = 'Connect and replace';
    dismissToast();
    ui.imgbbDialog.showModal();
    ui.key.focus();
};

const closeKeyDialog = () => {
    keySubmission += 1;
    ui.saveKey.removeAttribute('aria-busy');
    ui.key.value = '';
    if (ui.imgbbDialog.open) ui.imgbbDialog.close();
};

const offlineToast = () => toast('You’re offline. Copy or export the image, or upload when you’re back online.', {
    action: 'Export image', onAction: () => { dismissToast(); void exportImage(); }, duration: 9000,
});

const submitKeyDialog = () => {
    const key = ImgbbClient.cleanKey(ui.key.value);
    if (!key) {
        dialogError('Enter the API key from ImgBB, with no spaces.');
        ui.key.focus();
        return;
    }
    if (ui.saveKey.getAttribute('aria-busy') === 'true') return;
    const remember = ui.rememberKey.checked;
    const submission = ++keySubmission;
    ui.saveKey.setAttribute('aria-busy', 'true');
    void requestPermissionInGesture().then(granted => {
        permissionGranted = granted;
        ui.saveKey.removeAttribute('aria-busy');
        // Cancelled, closed or resubmitted while the browser asked: record the
        // answer, start nothing.
        if (submission !== keySubmission || !ui.imgbbDialog.open) return;
        if (!granted) {
            dialogError('Allow Better Peakbagger to reach api.imgbb.com, then choose Connect again.');
            return;
        }
        pendingKey = { value: key, remember };
        pendingKeyReachedProvider = false;
        closeKeyDialog();
        renderFinish();
        if (navigator.onLine === false) { offlineToast(); return; }
        void uploadAndInsert();
    });
};

// The key held for an upload is saved, kept for this tab, or dropped only once
// the request has actually reached ImgBB.
const settlePendingKey = async ({ reached, keyRejected }: { reached: boolean; keyRejected: boolean }) => {
    if (!pendingKey || !reached) return;
    const held = pendingKey;
    pendingKey = null;
    pendingKeyReachedProvider = false;
    if (keyRejected) { renderFinish(); return; }
    // Usable for this tab at once, so the page never flickers back to "no key"
    // while the status check and save are in flight.
    sessionKey = held.value;
    renderFinish();
    await refreshCredential();
    if (configuredKey) { renderFinish(); return; }
    if (held.remember) {
        const response = await send({ type: 'PHOTO_IMGBB_SAVE_KEY', key: held.value });
        if (response?.ok) {
            configuredKey = true;
            sessionKey = '';
        }
        // Otherwise it stays usable here; the finish note says it lasts for this tab.
    }
    renderFinish();
};

const onFinishSlot = () => {
    if (unavailable(ui.upload)) return;
    if (ui.upload.dataset.kind === 'copy-link') {
        const url = (photo?.remote as TopoRemote | undefined)?.url;
        if (url) void copyTextWithFallback(url);
        return;
    }
    if (LOCAL_PHOTO_ID) { void saveLocalAndReturn(); return; }
    if (busy || !project || !sourceBitmap) return;
    if (['uploading', 'outcome-unknown'].includes(photo?.remote.state as string)) {
        toast(Output.NOTES['outcome-unknown'], { duration: 0 });
        return;
    }
    if (navigator.onLine === false) { offlineToast(); return; }
    if (keyMode() === 'none' && !pendingKey) { openKeyDialog(); return; }
    if (!permissionGranted) {
        void requestPermissionInGesture().then(granted => {
            permissionGranted = granted;
            if (granted) void uploadAndInsert();
            else toast('Allow Better Peakbagger to reach api.imgbb.com, then choose Upload again.');
        });
        return;
    }
    void uploadAndInsert();
};

// Copy, Export and the size estimate share one encode per revision and type,
// so a large photo is never flattened twice at once for the same answer.
const encodeForOutput = (snapshot: TopoProject, source: ImageBitmap, mime: string): Promise<EncodedExport> => {
    const revision = exportRevision;
    const current = snapshot.export.mime === mime && project?.export.mime === mime;
    if (current && cachedExport?.revision === revision) return Promise.resolve(cachedExport.encoded);
    if (current && exportEstimateJob?.revision === revision && exportEstimateJob.source === source) {
        return exportEstimateJob.promise;
    }
    const key = `${revision}:${mime}`;
    if (outputEncode?.key === key) return outputEncode.promise;
    const encodingProject = current ? snapshot : Project.cleanProject({ ...snapshot, export: { mime } });
    if (!encodingProject) return Promise.reject(new Error('The photo could not be prepared.'));
    if (current) {
        // This encode will answer the pending estimate too.
        clearTimeout(exportEstimateTimer!);
        exportEstimateTimer = null;
    }
    const promise = (Renderer.estimateProject({ project: encodingProject, source } as never) as Promise<EncodedExport>)
        .then(encoded => {
            if (current && revision === exportRevision && source === sourceBitmap) {
                cachedExport = { revision, encoded };
                showExportEstimate(encoded);
            }
            return encoded;
        }, error => {
            if (current && revision === exportRevision && source === sourceBitmap) {
                if (exportEstimateJob) exportEstimatePending = true;
                else void refreshExportEstimate(revision);
            }
            throw error;
        });
    outputEncode = { key, promise };
    void promise.finally(() => { if (outputEncode?.key === key) outputEncode = null; }).catch(() => {});
    return promise;
};

const outputSnapshot = () => {
    if (!outputAvailable()) return null;
    settleEditorGestures();
    const snapshot = Project.cleanProject(project) as unknown as TopoProject | null;
    return snapshot && sourceBitmap ? { snapshot, source: sourceBitmap } : null;
};

const finishOutput = (kind: 'copy' | 'export', button: HTMLButtonElement, label: string) => {
    outputBusy[kind] = false;
    button.removeAttribute('aria-busy');
    setButtonLabel(button, label);
    renderFinish();
};

const copyImage = () => {
    if (unavailable(ui.copyImage) || outputBusy.copy) return;
    const prepared = outputSnapshot();
    if (!prepared) return;
    clearTimeout(copyResetTimer!);
    outputBusy.copy = true;
    ui.copyImage.setAttribute('aria-busy', 'true');
    setButtonLabel(ui.copyImage, 'Copying…');
    renderFinish();
    let written: Promise<void>;
    try {
        written = Output.writeImageToClipboard({
            encode: () => encodeForOutput(prepared.snapshot, prepared.source, 'image/png').then(encoded => encoded.blob),
        });
    } catch (error) {
        written = Promise.reject(error);
    }
    void written.then(() => {
        finishOutput('copy', ui.copyImage, 'Copied');
        setEditorStatus('Copied as PNG.');
        copyResetTimer = setTimeout(() => {
            copyResetTimer = null;
            if (!outputBusy.copy) setButtonLabel(ui.copyImage, 'Copy image');
        }, 2000);
    }, () => {
        finishOutput('copy', ui.copyImage, 'Copy image');
        toast('Couldn’t copy this image. Export it instead.', {
            action: 'Export image', onAction: () => { dismissToast(); void exportImage(); }, duration: 9000,
        });
    });
};

async function exportImage() {
    if (unavailable(ui.exportImage) || outputBusy.export) return;
    const prepared = outputSnapshot();
    if (!prepared) return;
    outputBusy.export = true;
    ui.exportImage.setAttribute('aria-busy', 'true');
    setButtonLabel(ui.exportImage, 'Exporting…');
    renderFinish();
    const title = ui.title.value;
    try {
        const encoded = await encodeForOutput(prepared.snapshot, prepared.source, prepared.snapshot.export.mime);
        const fileName = Output.exportFileName(title, encoded.mime);
        Output.downloadBlob({ blob: encoded.blob, fileName });
        setEditorStatus(`Downloading ${fileName} · ${formatBytes(encoded.bytes)}`);
    } catch {
        toast('This image could not be exported. Try again.', { duration: 9000 });
    } finally {
        finishOutput('export', ui.exportImage, 'Export image');
    }
}

const exportLibraryItem = async (item: TopoPhoto) => {
    const bundle = await store.getBundle(item.localId);
    if (!bundle?.original || !bundle.project) throw new Error('The original photo is not available on this device.');
    const bitmap = await decodeBlob(bundle.original);
    try {
        const encoded = await (Renderer.estimateProject({ project: bundle.project, source: bitmap } as never) as Promise<EncodedExport>);
        const fileName = Output.exportFileName(item.title, encoded.mime);
        Output.downloadBlob({ blob: encoded.blob, fileName });
        toast(`Downloading ${fileName} · ${formatBytes(encoded.bytes)}`);
    } finally {
        bitmap.close?.();
    }
};

const closeSource = () => {
    cancelExportEstimate();
    if (sourceBitmap?.close) sourceBitmap.close();
    sourceBitmap = null;
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
};

const decodeBlob = async (blob: Blob) => {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch { return createImageBitmap(blob); }
};

class PhotoSourcePreparationError extends Error {}

const preflightSourceStorage = async (sourceBytes: number) => {
    let storage;
    try { storage = navigator.storage; }
    catch { return; }
    if (!storage || typeof storage.estimate !== 'function') return;
    let estimate;
    try { estimate = await storage.estimate(); }
    catch { return; }
    const usage = Number(estimate?.usage);
    const quota = Number(estimate?.quota);
    if (!Number.isFinite(usage) || usage < 0 || !Number.isFinite(quota) || quota < usage) return;
    const required = sourceBytes + SOURCE_STORAGE_HEADROOM_BYTES;
    const available = quota - usage;
    if (available >= required) return;
    throw new PhotoSourcePreparationError(
        `This photo needs about ${formatBytes(required)} of free browser storage, but only `
        + `${formatBytes(available)} is available. Keep the original file, free browser storage, `
        + 'and try again.',
    );
};

const canvasBlob = (canvas: HTMLCanvasElement, mime: string, quality: number) => new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image encoding failed.')), mime, quality);
});

const makeThumbnail = async (bitmap: ImageBitmap) => {
    const maximum = 480;
    const ratio = Math.min(1, maximum / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvasBlob(canvas, 'image/jpeg', 0.82);
};

const defaultTitle = (name: string) => String(name || 'Photo')
    .replace(/\.[A-Za-z0-9]{1,10}$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Library.TITLE_LIMIT) || 'Photo';

const setSourceDisplay = (blob: Blob) => {
    camera = { fit: true, scale: 1, x: 0, y: 0 };
    endPan();
    cancelDrawing();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = URL.createObjectURL(blob);
    ui.sourceImage.src = sourceUrl;
    ui.sourceImage.alt = '';
    ui.stage.style.aspectRatio = `${project!.image.width} / ${project!.image.height}`;
    ui.overlay.setAttribute('viewBox', `0 0 ${project!.image.width} ${project!.image.height}`);
    ui.overlay.setAttribute('width', String(project!.image.width));
    ui.overlay.setAttribute('height', String(project!.image.height));
};

const cleanDraftFromFields = ({ now, project: draftProject, photo: draftPhoto, original, title, caption }: { now: string; project: TopoProject; photo: TopoPhoto | null; original: Blob; title: string; caption: string }) => {
    if (!draftProject || !original) return null;
    const fields = {
        title,
        caption,
    };
    if (!draftPhoto) {
        return Library.createDraft({
            localId: draftProject.localId,
            ...fields,
            alt: SOURCE_IMAGE_ALT,
            source: {
                fileName: (original as File).name || 'photo',
                mime: original.type,
                bytes: original.size,
                width: draftProject.image.width,
                height: draftProject.image.height,
                sha256: draftProject.image.sourceSha256,
            },
            now,
        } as never);
    }
    return Library.cleanPhoto({
        ...draftPhoto,
        ...fields,
        updatedAt: now,
    });
};

const currentDraftMatches = (snapshot: { revision: number; project: TopoProject; photo: TopoPhoto | null; original: Blob | null; thumbnail: Blob | null; title: string; caption: string }) => draftRevision === snapshot.revision
    && project === snapshot.project
    && (photo === snapshot.photo
        || (photo?.localId === snapshot.project?.localId
            && (snapshot.photo == null
                || photo.revision >= snapshot.photo.revision)))
    && originalBlob === snapshot.original
    && thumbnailBlob === snapshot.thumbnail
    && ui.title.value === snapshot.title
    && ui.caption.value === snapshot.caption;

const enqueueDraftWrite = (write: () => Promise<boolean>) => {
    const operation = draftWriteQueue.then(write, write);
    draftWriteQueue = operation.catch(() => false);
    return operation;
};

const persistDraft = async ({ required = false, replaceOtherTab = false } = {}) => {
    clearTimeout(autosaveTimer!);
    autosaveTimer = null;
    // Upload freezes editor mutations before taking its required snapshot. Let
    // an already-started autosave settle first; when it saved the current
    // generation, that durable result already satisfies the upload gate.
    if (required) {
        const saved = await draftWriteQueue;
        if (saved && !draftDirty) return true;
    }
    if (!project || !originalBlob || !thumbnailBlob
        || PUBLISHED_STATES.includes(photo?.remote.state as string)) return false;
    const now = new Date().toISOString();
    const snapshot = {
        revision: draftRevision,
        project,
        photo,
        original: originalBlob,
        thumbnail: thumbnailBlob,
        title: ui.title.value,
        caption: ui.caption.value,
    };
    const nextPhoto = cleanDraftFromFields({ now, ...snapshot });
    if (!nextPhoto) {
        setSaveStatus('Add a title to save');
        if (required) toast('Add a title before uploading.');
        return false;
    }
    const nextProject = Project.cleanProject({ ...snapshot.project, updatedAt: now });
    draftDirty = false;
    setSaveStatus('Saving locally…');
    return enqueueDraftWrite(async () => {
        try {
            let writePhoto = photo?.localId === nextPhoto.localId
                && photo.revision > nextPhoto.revision
                ? Library.cleanPhoto({ ...nextPhoto, revision: photo.revision })
                : nextPhoto;
            if (replaceOtherTab) {
                const latest = await store.getBundle(nextPhoto.localId);
                if (!latest.photo || latest.photo.deletedAt || latest.photo.remote.state !== 'draft'
                    || !latest.photo.assets.originalRetained || !latest.photo.assets.projectRetained
                    || !latest.project
                    || latest.photo.source.sha256 !== nextPhoto.source.sha256
                    || !Project.matchingImageDimensions(latest.project.image, nextPhoto.source)) {
                    throw new Store.PhotoStoreConflictError(nextPhoto.localId,
                        'This photo can no longer be replaced. Your edits are still open in this tab.');
                }
                // Keep references and backup state added by the other tab;
                // replace only the editor-owned title, caption, and project.
                writePhoto = cleanDraftFromFields({
                    now, project: snapshot.project, photo: latest.photo,
                    original: snapshot.original, title: snapshot.title, caption: snapshot.caption,
                });
            }
            const storedPhoto = await store.putDraft({
                photo: writePhoto,
                project: nextProject,
                original: snapshot.original,
                thumbnail: snapshot.thumbnail,
            });
            const stillCurrent = currentDraftMatches(snapshot);
            if (stillCurrent) {
                photo = storedPhoto;
                project = nextProject as unknown as TopoProject;
                ui.saveConflictedDraft.hidden = true;
                setSaveStatus('Saved on this device');
            } else if (!photo && project?.localId === storedPhoto!.localId) {
                // The first save may finish after the user has already edited
                // the new project. Adopt only its store identity/revision; the
                // queued follow-up still serializes the live fields and marks.
                photo = storedPhoto;
            } else if (photo?.localId === storedPhoto!.localId
                && photo.revision === snapshot.photo?.revision) {
                // Keep the newest store revision even when the user changed the
                // draft while this queued write was in flight. The next save
                // still owns the newer fields and project.
                photo = Library.cleanPhoto({ ...photo, revision: storedPhoto!.revision });
            }
            notifyBackupChanged();
            return !required || stillCurrent;
        } catch (error) {
            const stillCurrent = currentDraftMatches(snapshot);
            const quotaExceeded = (error as Error | null)?.name === 'QuotaExceededError';
            if (stillCurrent) {
                draftDirty = true;
                ui.saveConflictedDraft.hidden = !(error instanceof Store.PhotoStoreConflictError)
                    || storeReloadRequired;
                setSaveStatus(error instanceof Store.PhotoStoreConflictError
                    ? 'Not saved · changed in another tab. Your edits are still here.'
                    : quotaExceeded
                        ? 'Not saved · browser storage is full'
                        : 'Could not save locally');
                if (quotaExceeded && !required) {
                    toast('The editable copy could not be saved because browser storage is full. '
                        + 'Your original file was not changed. Free browser storage and try again.', {
                        duration: 9000,
                    });
                }
            }
            if (error instanceof Store.PhotoStoreConflictError) {
                if (replaceOtherTab) toast(error.message, { duration: 9000 });
                if (required) toast(error.message, { duration: 9000 });
                return false;
            }
            if (required && stillCurrent && confirm(
                'Better Peakbagger could not retain an editable local copy. '
                    + 'Continue with upload without the promise of future non-destructive editing?',
            )) {
                const minimal = (Library.updateAssets as (...args: unknown[]) => TopoPhoto)(nextPhoto, {
                    originalRetained: false,
                    projectRetained: false,
                    thumbnailRetained: false,
                }, now);
                try {
                    const storedPhoto = await store.putPhoto(minimal);
                    if (!currentDraftMatches(snapshot)) return false;
                    photo = storedPhoto;
                    project = nextProject as unknown as TopoProject;
                    draftDirty = false;
                    setSaveStatus('URL record only · editable copy not retained');
                    notifyBackupChanged();
                    return true;
                } catch {
                    toast('The photo catalog is unavailable, so upload cannot safely continue.');
                }
            }
            return false;
        }
    });
};

const schedulePersist = () => {
    if (editorMutationLocked()) return;
    draftRevision += 1;
    draftDirty = true;
    if (project && originalBlob && thumbnailBlob
        && !PUBLISHED_STATES.includes(photo?.remote.state as string)) {
        setSaveStatus('Unsaved changes');
    }
    clearTimeout(autosaveTimer!);
    autosaveTimer = setTimeout(() => {
        autosaveTimer = null;
        void persistDraft();
    }, AUTOSAVE_DELAY_MS);
};

const flushDraftPersistence = () => {
    clearTimeout(autosaveTimer!);
    autosaveTimer = null;
    return draftDirty ? persistDraft() : draftWriteQueue;
};

// Call while editor mutations are locked, before reading or installing the
// replacement project. An in-flight save may restore draftDirty on failure.
const settleOutgoingDraft = async () => {
    await draftWriteQueue;
    if (draftDirty && !await flushDraftPersistence()) {
        toast('This photo could not be saved. Your edits are still open. '
            + 'Resolve the save problem before opening another photo.', { duration: 9000 });
        return false;
    }
    return true;
};

const updateHistoryButtons = () => {
    ui.undo.disabled = !(drawingSession || routeSession?.points.length || history.length) || busy;
    ui.redo.disabled = (routeSession ? !routeSession.removedPoints.length : !future.length)
        || !!drawingSession || busy;
};

const selectedObject = () => project?.objects.find(object => object.id === selectedId) || null;

const percent = (opacity: number) => `${Math.round(opacity * 100)}%`;
const pixels = (value: number) => `${Math.round(value)} px`;

// The style controls describe the armed tool, not only a placed mark. Arming a
// tool shows the style its next mark will take, so a colour or a lower opacity
// can be chosen before the first click instead of being corrected after it.
// Select has nothing to preset, so it still shows the panel only for a
// selection. `type` is the object type either way: every placement tool is
// named for the type it places.
const inspectorType = () => selectedObject()?.type
    || (activeTool === 'select' ? null : activeTool);

const textField = ui.text.closest('label');
const textHome = document.createComment('Text inspector position');
textField!.after(textHome);
const narrowEditor = window.matchMedia?.('(max-width: 900px)');
const revealTextEditor = () => {
    const target = ui.textEditor.hidden ? ui.text : ui.textEditor;
    target.scrollIntoView?.({ block: ui.textEditor.hidden ? 'nearest' : 'end', inline: 'nearest' });
};
const syncTextEditor = () => {
    const docked = (narrowEditor?.matches ?? window.innerWidth <= 900) && selectedObject()?.type === 'text';
    const parent = docked ? ui.textEditor : textHome.parentNode;
    const moved = textField!.parentNode !== parent;
    const focused = document.activeElement === ui.text;
    const selection = [ui.text.selectionStart, ui.text.selectionEnd, ui.text.selectionDirection];
    if (moved) {
        if (docked) parent!.append(textField!);
        else parent!.insertBefore(textField!, textHome);
    }
    ui.textEditor.hidden = !docked;
    ui.textEditor.parentElement!.classList.toggle('editing-text', docked);
    if (focused && moved) {
        ui.text.focus({ preventScroll: true });
        ui.text.setSelectionRange(...(selection as [number, number]));
        revealTextEditor();
    }
};

const renderInspector = () => {
    const object = selectedObject();
    const type = inspectorType();
    ui.inspector.hidden = !type;
    syncTextEditor();
    if (!type) return;
    const route = ['route', 'drawing'].includes(type);
    const label = type === 'pitch' || type === 'text';
    const text = type === 'text';
    const pitch = type === 'pitch';
    ui.inspectorHeading.textContent = object ? 'Selection' : `${toolName(type)} style`;
    document.querySelectorAll<HTMLElement>('.route-only').forEach(node => { node.hidden = !route; });
    document.querySelectorAll<HTMLElement>('.scale-only').forEach(node => { node.hidden = route; });
    // Content belongs to the placed mark; appearance can be preset per tool.
    // Anchor and Belay are circular, so rotation cannot change their appearance.
    document.querySelectorAll<HTMLElement>('.point-only').forEach(node => {
        node.hidden = route || type === 'anchor' || type === 'belay';
    });
    document.querySelectorAll<HTMLElement>('.pitch-only').forEach(node => { node.hidden = !pitch || !object; });
    document.querySelectorAll<HTMLElement>('.text-only').forEach(node => { node.hidden = !text || !object; });
    document.querySelectorAll<HTMLElement>('.label-only').forEach(node => { node.hidden = !label; });
    ui.align.closest('label')!.hidden = !text;
    ui.objectActions.hidden = !object;
    const style = (object ? object.style : toolPreferences[type]!.style) as TopoObject['style'];
    ui.color.value = style.color;
    ui.opacity.value = String(Math.round(style.opacity * 100));
    ui.opacityValue.textContent = percent(style.opacity);
    if (route) {
        ui.routeWidth.value = String(style.width);
        ui.routeWidthValue.textContent = pixels(style.width);
        ui.routeStroke.value = style.stroke;
        ui.routeArrow.checked = style.end === 'arrow';
        ui.routeSmooth.checked = style.smooth;
    } else {
        ui.scale.value = String(style.scale);
        ui.scaleValue.textContent = pixels(Renderer.objectSizePixels(type, project!.image, style.scale));
    }
    if (!object) {
        ui.rotation.value = String(toolPreferences[type]!.rotation);
        ui.rotationValue.textContent = `${toolPreferences[type]!.rotation}°`;
        if (text) ui.align.value = style.align;
        if (label) ui.background.checked = style.background;
        return;
    }
    if (!route) {
        ui.rotation.value = String(Math.round(object.geometry.rotation));
        ui.rotationValue.textContent = `${Math.round(object.geometry.rotation)}°`;
    }
    if (pitch) ui.pitch.value = String(object.pitch);
    if (text) {
        // Keep the uncommitted trailing space in the focused field until the
        // next word makes it part of the normalized project text.
        if (document.activeElement !== ui.text || ui.text.value.trim() !== object.text) {
            ui.text.value = object.text;
        }
        ui.textWidth.max = String(Project.MAX_DIMENSION);
        if (document.activeElement !== ui.textWidth) {
            ui.textWidth.value = object.geometry.width == null ? '' : String(Math.round(object.geometry.width));
        }
        ui.textWidthAuto.setAttribute('aria-pressed', String(object.geometry.width == null));
        ui.align.value = object.style.align;
    }
    if (label) ui.background.checked = object.style.background;
};

const annotationName = (object: TopoObject) => {
    if (object.type === 'drawing') return 'Freehand stroke';
    if (object.type === 'route') {
        return `Route, ${object.geometry.points.length} points`;
    }
    if (object.type === 'pitch') return `Pitch ${object.pitch}`;
    if (object.type === 'text') {
        const text = object.text.length > 60 ? `${object.text.slice(0, 59)}…` : object.text;
        return `Text: ${text}`;
    }
    return toolName(object.type);
};

// The exported SVG is deliberately hidden from the accessibility tree. This
// list is the one semantic representation of its marks, with stable ids used
// to restore focus after every immutable project rerender.
const renderAnnotationBrowser = () => {
    const focused = document.activeElement;
    const restoreObjectId = ui.annotationList.contains(focused)
        ? (focused as HTMLElement).dataset.objectId
        : null;
    const restoreVertex = ui.routePointList.contains(focused)
        ? (focused as HTMLElement).dataset.vertex
        : null;
    ui.annotationList.replaceChildren(...project!.objects.map((object, index) => {
        const item = element('li');
        const button = element<HTMLButtonElement>('button', 'annotation-select', annotationName(object));
        button.type = 'button';
        button.dataset.objectId = object.id;
        button.setAttribute(
            'aria-label',
            `${annotationName(object)}, layer ${index + 1} of ${project!.objects.length}`
        );
        button.setAttribute('aria-pressed', String(object.id === selectedId));
        item.append(button);
        return item;
    }));
    ui.annotationEmpty.hidden = project!.objects.length > 0;

    const selected = selectedObject();
    const route = selected?.type === 'route' ? selected : null;
    if (route && (!Number.isInteger(selectedVertex)
        || selectedVertex! < 0 || selectedVertex! >= route.geometry.points.length)) {
        selectedVertex = null;
    }
    ui.routePoints.hidden = !route;
    ui.routePointList.replaceChildren(...(route ? route.geometry.points.map((point: TopoPoint, index: number) => {
        const item = element('li');
        const button = element<HTMLButtonElement>(
            'button',
            'route-point-select',
            `Point ${index + 1}: ${Math.round(point[0])}, ${Math.round(point[1])}`
        );
        button.type = 'button';
        button.dataset.objectId = route.id;
        button.dataset.vertex = String(index);
        button.setAttribute('aria-pressed', String(index === selectedVertex));
        item.append(button);
        return item;
    }) : []));
    updateEditorControls();

    if (restoreVertex != null) {
        [...ui.routePointList.querySelectorAll<HTMLElement>('[data-vertex]')]
            .find(button => button.dataset.vertex === restoreVertex)?.focus();
    } else if (restoreObjectId) {
        [...ui.annotationList.querySelectorAll<HTMLElement>('[data-object-id]')]
            .find(button => button.dataset.objectId === restoreObjectId)?.focus();
    }
};

// The first click of a route cannot create an object yet — the schema needs two
// points — so nothing appeared on the photo until the second click landed. Draw
// the pending point, and rubber-band the segment the next click would commit.
const renderRoutePreview = () => {
    ui.overlay.querySelector('.route-preview')?.remove();
    if (!routeSession?.points.length || !project) return;
    const group = document.createElementNS(SVG_NS, 'g');
    group.classList.add('route-preview');
    const unit = Math.min(project.image.width, project.image.height);
    const last = routeSession.points[routeSession.points.length - 1];
    if (routeSession.cursor) {
        const segment = document.createElementNS(SVG_NS, 'line');
        segment.classList.add('route-preview-line');
        segment.setAttribute('x1', String(last[0]));
        segment.setAttribute('y1', String(last[1]));
        segment.setAttribute('x2', String(routeSession.cursor[0]));
        segment.setAttribute('y2', String(routeSession.cursor[1]));
        segment.setAttribute('stroke-dasharray', `${unit * 0.012} ${unit * 0.012}`);
        group.append(segment);
    }
    // Past the first point the committed route already draws its own vertex
    // handles, so only the point with no object behind it needs a stand-in.
    if (routeSession.points.length === 1) {
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.classList.add('route-preview-dot');
        dot.setAttribute('cx', String(last[0]));
        dot.setAttribute('cy', String(last[1]));
        dot.setAttribute('r', String(unit * 0.012));
        group.append(dot);
    }
    ui.overlay.append(group);
};

const renderTextBoxControls = (object: TopoObject) => {
    const group = [...ui.overlay.querySelectorAll<HTMLElement>('[data-bpb-object]')]
        .find(node => node.getAttribute('data-bpb-object') === object.id);
    const box = group?.querySelector('[data-bpb-text-box]');
    if (!box) return;
    const controls = document.createElementNS(SVG_NS, 'g');
    controls.setAttribute('transform', group!.getAttribute('transform')!);
    const outline = box.cloneNode() as Element;
    outline.removeAttribute('data-bpb-text-box');
    outline.classList.add('text-box-outline');
    controls.append(outline);
    const x = Number(box.getAttribute('x'));
    const width = Number(box.getAttribute('width'));
    const middle = Number(box.getAttribute('y')) + Number(box.getAttribute('height')) / 2;
    const screenScale = ui.overlay.getBoundingClientRect().width / project!.image.width;
    const radius = 6 / (screenScale || 1);
    const cursor = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][
        ((Math.round(object.geometry.rotation / 45) % 4) + 4) % 4];
    for (const side of ['left', 'right']) {
        const handle = document.createElementNS(SVG_NS, 'circle');
        handle.classList.add('text-width-handle');
        handle.dataset.textResize = side;
        handle.dataset.objectId = object.id;
        handle.dataset.width = String(width);
        handle.setAttribute('cx', String(x + (side === 'right' ? width : 0)));
        handle.setAttribute('cy', String(middle));
        handle.setAttribute('r', String(radius));
        handle.style.cursor = cursor;
        controls.append(handle);
    }
    ui.overlay.append(controls);
};

const renderProject = () => {
    if (!project) return;
    applyReportWidthPreview();
    // Export SVG contains pixels only. The editor variant adds transparent,
    // geometry-aware hit regions so open symbols and thin strokes are selectable
    // across their visible footprint instead of only on a painted SVG edge.
    const parsed = new DOMParser().parseFromString(
        Renderer.renderOverlaySvg(project, { interactive: true }),
        'image/svg+xml'
    );
    const root = parsed.documentElement;
    ui.overlay.replaceChildren(...Array.from(root.childNodes, child => document.importNode(child, true)));
    for (const node of ui.overlay.querySelectorAll<HTMLElement>('[data-bpb-object]')) {
        if (node.getAttribute('data-bpb-object') === selectedId) node.classList.add('selected');
    }
    const selected = selectedObject();
    // Vertex handles belong to Select. Left on screen while a placement tool is
    // armed they swallow the click that should have placed a symbol, and the
    // symbols a user most wants sit exactly on the route they just drew.
    if (activeTool === 'select' && selected?.type === 'route') {
        const radius = Math.min(project.image.width, project.image.height) * 0.012;
        selected.geometry.points.forEach((point: TopoPoint, index: number) => {
            const handle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            handle.classList.add('vertex-handle');
            handle.dataset.objectId = selected.id;
            handle.dataset.vertex = String(index);
            handle.setAttribute('cx', String(point[0]));
            handle.setAttribute('cy', String(point[1]));
            handle.setAttribute('r', String(radius));
            handle.setAttribute('aria-label', `Route vertex ${index + 1}`);
            ui.overlay.append(handle);
        });
    }
    if (activeTool === 'select' && selected?.type === 'text') renderTextBoxControls(selected);
    renderAnnotationBrowser();
    renderRoutePreview();
    ui.exportSummary.textContent = `${project.objects.length} annotation${project.objects.length === 1 ? '' : 's'}`
        + ` · ${project.image.width} × ${project.image.height}`;
    renderInspector();
    updateEditorControls();
};

// A slider drag, a run of typing, and a held arrow key are each one thing the
// user did, so each is one Undo. They emit a continuous stream of edits, and
// giving every intermediate value its own history entry made Undo step back a
// tick at a time — worse, one drag of Route width (1–100) pushed 100 entries
// and evicted every real edit behind it from a 100-deep history. A run is
// identified by its control and mark; it ends when the gesture does.
let coalescing: string | null = null;
const endCoalescing = () => { coalescing = null; };

const setProject = (next: unknown, { pushHistory = true, persist = true, coalesce = null }: UpdateOptions = {}) => {
    if (editorMutationLocked()) return false;
    const cleaned = Project.cleanProject(next);
    if (!cleaned) return false;
    const continuing = coalesce !== null && coalesce === coalescing;
    if (pushHistory && project && !continuing) {
        history.push(structuredClone(project!));
        if (history.length > HISTORY_LIMIT) history.shift();
        future = [];
    }
    coalescing = pushHistory ? coalesce : null;
    project = cleaned as unknown as TopoProject;
    invalidateExportEstimate();
    renderProject();
    if (persist) schedulePersist();
    return true;
};

const undo = () => {
    if (editorMutationLocked() || !project) return;
    if (drawingSession) { cancelDrawing(); return; }
    if (routeSession?.points.length) {
        routeSession.removedPoints.push(routeSession.points.pop()!);
        routeSession.lastPress = null;
        renderPendingRoute();
        schedulePersist();
        setEditorStatus('Last route point removed. Click to continue, or Redo to restore it.');
        return;
    }
    if (routeSession) finishRoute(true);
    if (!history.length) return;
    endCoalescing();
    future.push(structuredClone(project));
    project = history.pop()!;
    selectedId = project!.objects.some(object => object.id === selectedId) ? selectedId : null;
    if (!selectedId) selectedVertex = null;
    routeSession = null;
    ui.finishRoute.hidden = true;
    invalidateExportEstimate();
    renderProject();
    schedulePersist();
};

const redo = () => {
    if (editorMutationLocked() || !project || drawingSession) return;
    if (routeSession) {
        if (!routeSession.removedPoints.length) return;
        routeSession.points.push(routeSession.removedPoints.pop()!);
        routeSession.lastPress = null;
        renderPendingRoute();
        schedulePersist();
        setEditorStatus('Route point restored. Click to continue, or Enter to finish.');
        return;
    }
    if (!future.length) return;
    endCoalescing();
    history.push(structuredClone(project!));
    project = future.pop()!;
    selectedId = project!.objects.some(object => object.id === selectedId) ? selectedId : null;
    if (!selectedId) selectedVertex = null;
    invalidateExportEstimate();
    renderProject();
    schedulePersist();
};

const toolName = (tool: string) => document.querySelector(`[data-tool="${tool}"] .tool-name`)?.textContent
    || tool;

// Placement tools stay armed until the user leaves them. Snapping back to
// Select after one symbol made marking a pitch a click-a-tool-per-symbol chore;
// Esc and V are the way out, and the status line says so.
const setTool = (tool: string | undefined) => {
    if (editorMutationLocked()) return;
    cancelDrawing();
    handMode = false;
    updatePanCursor();
    activeTool = tool!;
    document.querySelectorAll<HTMLElement>('[data-tool]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
    });
    // A placement tool's panel describes the mark it is about to place, so
    // arming one lets go of the current selection — including a route that the
    // switch itself just finished. Select keeps it: pressing V after placing a
    // symbol is how the user goes on to adjust that symbol.
    if (tool !== 'select') {
        selectedId = null;
        selectedVertex = null;
    }
    if (tool !== 'route' && routeSession) finishRoute(false);
    // Which handles are on screen depends on the armed tool, so the canvas has
    // to be repainted when it changes.
    else if (project) renderProject();
    setEditorStatus(tool === 'select'
        ? 'Select a mark to move, restyle, or copy it.'
        : tool === 'drawing'
            ? 'Drag to draw. Each stroke is one Undo step. Esc cancels a stroke.'
            : tool === 'route'
                ? 'Click along the route, or add one at center. Double-click, right-click, or press Enter to finish.'
                : `${toolName(tool!)}: click the photo or add one at center. Esc returns to Select.`);
};

const pointerPoint = (event: PointerEvent): TopoPoint => {
    const rect = ui.overlay.getBoundingClientRect();
    return [
        (event.clientX - rect.left) * project!.image.width / rect.width,
        (event.clientY - rect.top) * project!.image.height / rect.height,
    ];
};

const defaultStyle = (type = activeTool) => ({ ...toolPreferences[type]!.style }) as TopoObject['style'];
const defaultRouteStyle = () => defaultStyle('route');

// Finishing on a double-click cannot be left to the browser's `dblclick`.
// Every press repaints the overlay, so the second release lands on a node that
// did not exist when its own press fired, and Chrome then withholds the paired
// `click` — and with it the `dblclick` that used to end the route. The gesture
// is recognised from the presses instead: a second press on the same spot
// inside the double-click interval finishes the route rather than stacking a
// duplicate point on top of the last one. Screen coordinates, not image ones,
// because the slop has to mean the same thing whatever the photo's scale.
const DOUBLE_PRESS_MS = 400;
const DOUBLE_PRESS_SLOP = 8;

const pressOf = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY, at: event.timeStamp });

const isDoublePress = (previous: RouteSession['lastPress'], press: NonNullable<RouteSession['lastPress']>) => !!previous
    && !!press
    && press.at - previous.at <= DOUBLE_PRESS_MS
    && Math.abs(press.x - previous.x) <= DOUBLE_PRESS_SLOP
    && Math.abs(press.y - previous.y) <= DOUBLE_PRESS_SLOP;

// Route points have their own in-progress Undo/Redo. The finished route still
// occupies one project-history entry, including style changes made while drawing.
const renderPendingRoute = () => {
    const session = routeSession;
    const existing = project!.objects.find(object => object.id === session!.id);
    if (session!.points.length < 2) {
        project = session!.baseline;
        history = session!.historyBefore.slice();
        future = session!.futureBefore.slice();
        session!.historyPushed = false;
        selectedId = null;
    } else {
        const object = {
            id: session!.id, type: 'route',
            geometry: { points: session!.points, controls: [] },
            style: defaultRouteStyle(),
        };
        const next = existing ? Project.updateObject(project, session!.id, { geometry: object.geometry })
            : Project.addObject(session!.baseline, object);
        if (!next) return false;
        if (!session!.historyPushed) {
            history.push(structuredClone(session!.baseline));
            if (history.length > HISTORY_LIMIT) history.shift();
            future = [];
            session!.historyPushed = true;
        }
        project = next as unknown as TopoProject;
        selectedId = session!.id;
    }
    selectedVertex = null;
    invalidateExportEstimate();
    renderProject();
    return true;
};

const addRoutePoint = (point: TopoPoint, press: NonNullable<RouteSession['lastPress']>) => {
    if (editorMutationLocked()) return;
    if (routeSession && isDoublePress(routeSession.lastPress, press)) {
        finishRoute(false);
        return;
    }
    if (!routeSession) {
        routeSession = {
            id: crypto.randomUUID(),
            baseline: structuredClone(project!),
            points: [point],
            cursor: null,
            historyPushed: false,
            historyBefore: history.slice(),
            futureBefore: future.slice(),
            removedPoints: [],
            lastPress: press,
        };
        ui.finishRoute.hidden = false;
        setEditorStatus('Route started. Click the next point; double-click, right-click, or Enter finishes.');
        renderRoutePreview();
        updateHistoryButtons();
        return;
    }
    routeSession.lastPress = press;
    routeSession.points.push(point);
    if (!renderPendingRoute()) {
        routeSession.points.pop();
        routeSession.lastPress = null;
        return;
    }
    routeSession.removedPoints = [];
    updateHistoryButtons();
};

const finishRoute = (cancel: boolean) => {
    if (editorMutationLocked() || !routeSession) return;
    const changed = routeSession.historyPushed;
    if (cancel) {
        project = routeSession.baseline;
        history = routeSession.historyBefore;
        future = routeSession.futureBefore;
        selectedId = null;
        selectedVertex = null;
        setEditorStatus('Route cancelled.');
    } else if (routeSession.points.length < 2) {
        setEditorStatus('Route discarded because it needs at least two points.');
    } else {
        setEditorStatus('Route added. Click to start another, or press V to select.');
        schedulePersist();
    }
    routeSession = null;
    ui.finishRoute.hidden = true;
    if (changed) invalidateExportEstimate();
    renderProject();
    if (cancel && changed) schedulePersist();
};

const addPointObject = (type: string, point: TopoPoint) => {
    if (editorMutationLocked()) return;
    const base = {
        id: crypto.randomUUID(),
        type,
        geometry: { x: point[0], y: point[1], rotation: toolPreferences[type]!.rotation },
        style: defaultStyle(type),
    };
    let object: object = base;
    if (type === 'pitch') {
        object = {
            ...base,
            pitch: Number(ui.pitch.value || 1),
            style: base.style,
        };
    }
    if (type === 'text') {
        object = {
            ...base,
            text: 'Label',
            geometry: { ...base.geometry, width: Object.hasOwn(toolPreferences.text!, 'width')
                ? (toolPreferences.text as unknown as { width: number | null }).width : null },
            style: base.style,
        };
    }
    const next = Project.addObject(project, object);
    if (!next) return;
    selectedId = (object as TopoObject).id;
    selectedVertex = null;
    setProject(next);
    setEditorStatus(`${toolName(type)} placed. Click or add at center to place another, or press V to select.`);
    if (type === 'text') {
        ui.text.focus({ preventScroll: true });
        ui.text.select();
        revealTextEditor();
    }
};

const addAtCenter = () => {
    if (!project || editorMutationLocked() || ['select', 'drawing'].includes(activeTool) || routeSession) return;
    const center: TopoPoint = [project.image.width / 2, project.image.height / 2];
    if (activeTool !== 'route') {
        addPointObject(activeTool, center);
        return;
    }
    const half = Math.min(project.image.width, project.image.height) * 0.08;
    const object = {
        id: crypto.randomUUID(),
        type: 'route',
        geometry: {
            points: [[center[0] - half, center[1]], [center[0] + half, center[1]]],
            controls: [],
        },
        style: defaultRouteStyle(),
    };
    const next = Project.addObject(project, object);
    if (!next) return;
    selectedId = object.id;
    selectedVertex = null;
    setProject(next);
    setEditorStatus('Route added at the photo center. Press V to select it and edit its points.');
};

const selectAnnotation = (objectId: string, vertex: number | null = null) => {
    if (editorMutationLocked()) return;
    const object = project?.objects.find(candidate => candidate.id === objectId);
    if (!object) return;
    if (activeTool !== 'select') setTool('select');
    selectedId = object.id;
    selectedVertex = object.type === 'route' && Number.isInteger(vertex) ? vertex : null;
    renderProject();
    setEditorStatus(selectedVertex == null
        ? `${annotationName(object)} selected. Use the arrow keys to move it.`
        : `Route point ${selectedVertex + 1} selected. Use the arrow keys to move it.`);
};

const translatedGeometry = (object: TopoObject, dx: number, dy: number) => {
    if (!['route', 'drawing'].includes(object.type)) {
        return { ...object.geometry, x: object.geometry.x + dx, y: object.geometry.y + dy };
    }
    return {
        points: object.geometry.points.map(point => [point[0] + dx, point[1] + dy]),
        controls: object.geometry.controls.map(control => control ? {
            in: control.in ? [control.in[0] + dx, control.in[1] + dy] : null,
            out: control.out ? [control.out[0] + dx, control.out[1] + dy] : null,
        } : null),
    };
};

// Freehand stays transient until release: one stroke, one model validation,
// one Undo step. Cancellation cannot leave a partial stroke in autosave.
const cancelDrawing = () => {
    if (!drawingSession) return;
    const { pointerId } = drawingSession;
    drawingSession = null;
    ui.overlay.querySelector('.drawing-preview')?.remove();
    if (ui.overlay.hasPointerCapture?.(pointerId)) ui.overlay.releasePointerCapture(pointerId);
    updateHistoryButtons();
};
const drawingPoint = (event: PointerEvent) => pointerPoint(event).map((value, axis) =>
    Math.max(0, Math.min(axis ? project!.image.height : project!.image.width, value))) as TopoPoint;
const moveDrawing = (event: PointerEvent) => {
    const session = drawingSession;
    if (!session || event.pointerId !== session.pointerId) return;
    const point = drawingPoint(event);
    const last = session.points.at(-1);
    const rect = ui.overlay.getBoundingClientRect();
    if (Math.hypot(point[0] - last![0], point[1] - last![1]) * rect.width / project!.image.width < 1.5) return;
    // Preserve the whole gesture under the shared route/project point budgets.
    if (session.points.length >= session.limit) {
        session.points = session.points.filter((_, index: number) => index % 2 === 0);
    }
    session.points.push(point);
    session.preview!.setAttribute('points', session.points.map(p => p.join(',')).join(' '));
};
const beginDrawing = (event: PointerEvent) => {
    if (drawingSession) return;
    const used = project!.objects.reduce((sum, object) => sum + (object.geometry.points?.length || 1), 0);
    const limit = Math.min(Project.MAX_ROUTE_POINTS, Project.MAX_PROJECT_POINTS - used);
    if (limit < 2 || project!.objects.length >= Project.MAX_OBJECTS) {
        setEditorStatus('This photo has reached its annotation limit. Remove a mark before drawing.');
        return;
    }
    selectedId = null;
    selectedVertex = null;
    renderProject();
    const style = defaultStyle('drawing');
    const point = drawingPoint(event);
    const preview = document.createElementNS(SVG_NS, 'polyline');
    preview.classList.add('drawing-preview');
    preview.setAttribute('fill', 'none');
    preview.setAttribute('stroke', style.color);
    preview.setAttribute('stroke-width', style.width as unknown as string);
    preview.setAttribute('stroke-opacity', style.opacity as unknown as string);
    preview.setAttribute('stroke-linecap', 'round');
    preview.setAttribute('stroke-linejoin', 'round');
    preview.setAttribute('pointer-events', 'none');
    preview.setAttribute('points', `${point.join(',')} ${point.join(',')}`);
    ui.overlay.append(preview);
    drawingSession = { pointerId: event.pointerId, points: [point], style, preview, limit };
    updateHistoryButtons();
    ui.overlay.setPointerCapture?.(event.pointerId);
    event.preventDefault();
};
const finishDrawing = (event: PointerEvent) => {
    if (!drawingSession || event.pointerId !== drawingSession.pointerId) return;
    moveDrawing(event);
    const { points, style } = drawingSession;
    if (points.length === 1) points.push([...points[0]]);
    const object = {
        id: crypto.randomUUID(), type: 'drawing',
        geometry: { points, controls: [] }, style,
    };
    cancelDrawing();
    const next = Project.addObject(project, object);
    if (!next) { setEditorStatus('The stroke could not be added. Remove a mark and try again.'); return; }
    selectedId = object.id;
    setProject(next);
    setEditorStatus('Stroke added. Drag to draw another, or press V to select.');
};

const beginDrag = (event: PointerEvent, objectId: string | undefined | null, vertex: number | null = null, resize: DragSession['resize'] = null) => {
    if (editorMutationLocked()) return;
    const object = project!.objects.find(candidate => candidate.id === objectId);
    if (!object) return;
    endCoalescing();
    dragSession = {
        start: pointerPoint(event),
        baseline: resize ? project! : structuredClone(project!),
        object: structuredClone(object),
        vertex,
        resize,
        pointerId: event.pointerId,
        moved: false,
    };
    if (!resize) {
        history.push(structuredClone(project!));
        if (history.length > HISTORY_LIMIT) history.shift();
        future = [];
    }
    ui.overlay.setPointerCapture?.(event.pointerId);
};

const moveDrag = (event: PointerEvent) => {
    if (editorMutationLocked()) return;
    if (dragSession?.resize && event.pointerId !== dragSession.pointerId) return;
    if (drawingSession) { moveDrawing(event); return; }
    if (routeSession) {
        routeSession.cursor = pointerPoint(event);
        renderRoutePreview();
    }
    if (!dragSession) return;
    const point = pointerPoint(event);
    const dx = point[0] - dragSession.start[0];
    const dy = point[1] - dragSession.start[1];
    if (!dragSession.resize && Math.abs(dx) + Math.abs(dy) < 0.01) return;
    dragSession.moved = true;
    let geometry;
    if (dragSession.resize) {
        const object = dragSession.object;
        const angle = object.geometry.rotation * Math.PI / 180;
        const localDx = dx * Math.cos(angle) + dy * Math.sin(angle);
        const { side, width: previousWidth } = dragSession.resize;
        const width = Math.max(1, Math.min(Project.MAX_DIMENSION,
            previousWidth + (side === 'right' ? localDx : -localDx)));
        const align = object.style.align === 'center' ? 0.5 : object.style.align === 'right' ? 1 : 0;
        const shift = (width - previousWidth) * (align - (side === 'left' ? 1 : 0));
        geometry = { ...object.geometry, width,
            x: object.geometry.x + shift * Math.cos(angle),
            y: object.geometry.y + shift * Math.sin(angle) };
        dragSession.moved = Math.abs(width - previousWidth) > 0.01;
    } else if (dragSession.object.type === 'route' && dragSession.vertex != null) {
        const index = dragSession.vertex;
        // `existing` is this vertex's own stored position. It was named
        // `point` and shadowed the pointer position above, so the untouched
        // branch below read as "keep the cursor" while meaning "keep the
        // vertex" — the two are the same identifier and opposite values.
        const points = dragSession.object.geometry.points.map((existing, at) => at === index
            ? [existing[0] + dx, existing[1] + dy]
            : existing);
        // Clearing the controls hands the curve back to the model, the same way
        // adding a point does. Translating only this vertex's own handles left
        // its neighbours' tangents aimed at where the vertex used to be, so a
        // smooth route kinked away from the point the user was dragging.
        geometry = { points, controls: [] };
    } else {
        geometry = translatedGeometry(dragSession.object, dx, dy);
    }
    const next = Project.updateObject(dragSession.baseline, dragSession.object.id, { geometry });
    if (!next) return;
    project = next as unknown as TopoProject;
    renderProject();
    if (dragSession.resize) {
        // The preview must not leak into a pending autosave or export estimate.
        dragSession.preview = next as unknown as TopoProject;
        project = dragSession.baseline;
    }
};

const endDrag = () => {
    if (!dragSession) return;
    if (dragSession.resize) {
        const session = dragSession;
        dragSession = null;
        if (session.moved && session.preview) {
            if (setProject(session.preview)) rememberTool('text', { width: selectedObject()!.geometry.width } as never);
        }
        else renderProject();
        if (ui.overlay.hasPointerCapture?.(session.pointerId)) ui.overlay.releasePointerCapture(session.pointerId);
        return;
    }
    if (!dragSession.moved) history.pop();
    else {
        invalidateExportEstimate();
        schedulePersist();
    }
    dragSession = null;
    updateHistoryButtons();
};

const cancelTextResize = () => {
    if (!dragSession?.resize) return false;
    const session = dragSession;
    dragSession = null;
    project = session.baseline;
    if (ui.overlay.hasPointerCapture?.(session.pointerId)) ui.overlay.releasePointerCapture(session.pointerId);
    renderProject();
    return true;
};

const settleEditorGestures = () => {
    cancelDrawing();
    if (routeSession) finishRoute(false);
    const pointerId = dragSession?.pointerId;
    if (!cancelTextResize()) endDrag();
    if (pointerId != null && ui.overlay.hasPointerCapture?.(pointerId)) ui.overlay.releasePointerCapture(pointerId);
    spacePan = false;
    endPan();
    endCoalescing();
};

const onPointerDown = (event: PointerEvent) => {
    if (!project || editorMutationLocked() || event.button !== 0) return;
    const resizeNode = activeTool === 'select' ? (event.target as Element).closest?.<HTMLElement>('[data-text-resize]') : null;
    if (resizeNode) {
        event.preventDefault();
        ui.viewport.focus({ preventScroll: true });
        beginDrag(event, resizeNode.dataset.objectId, null, {
            side: resizeNode.dataset.textResize!, width: Number(resizeNode.dataset.width),
        });
        return;
    }
    if (activeTool === 'drawing') { beginDrawing(event); return; }
    const vertexNode = activeTool === 'select' ? (event.target as Element).closest?.<HTMLElement>('[data-vertex]') : null;
    if (vertexNode) {
        selectedId = vertexNode.dataset.objectId!;
        selectedVertex = Number(vertexNode.dataset.vertex);
        renderProject();
        beginDrag(event, selectedId, Number(vertexNode.dataset.vertex));
        return;
    }
    if (activeTool === 'route') {
        addRoutePoint(pointerPoint(event), pressOf(event));
        return;
    }
    if (activeTool !== 'select') {
        // The default pointer press focuses the viewport after placement,
        // stealing the label field's focus and turning typing into shortcuts.
        if (activeTool === 'text') event.preventDefault();
        addPointObject(activeTool, pointerPoint(event));
        return;
    }
    const objectNode = (event.target as Element).closest?.('[data-bpb-object]');
    selectedId = objectNode?.getAttribute('data-bpb-object') || null;
    selectedVertex = null;
    renderProject();
    if (selectedId) beginDrag(event, selectedId);
};

// `coalesce` names the control being dragged or typed into; it is scoped to the
// mark so moving to a different one always starts a new Undo step.
const updateSelected = (patch: Partial<TopoObject>, { coalesce = null }: UpdateOptions = {}) => {
    if (editorMutationLocked()) return;
    const object = selectedObject();
    if (!object) return;
    const next = Project.updateObject(project, object.id, patch);
    if (!next) return;
    const styleChanges = Object.fromEntries(Object.entries(patch.style || {})
        .filter(([key, value]) => value !== (object.style as Record<string, unknown>)[key]));
    if (patch.style || patch.geometry?.rotation != null || (object.type === 'text' && patch.geometry)) {
        rememberTool(object.type, {
            ...(patch.style ? { style: styleChanges } : {}),
            ...(patch.geometry?.rotation != null ? { rotation: patch.geometry.rotation } : {}),
            ...(object.type === 'text' && Object.hasOwn(patch.geometry || {}, 'width')
                ? { width: patch.geometry!.width } : {}),
        } as never);
    }
    setProject(next, {
        pushHistory: object.id !== routeSession?.id,
        coalesce: coalesce && `${coalesce}:${object.id}`,
    });
};

// One control, two subjects: with a mark selected it restyles that mark, and
// with only a tool armed it sets what the next mark will be. Presetting a tool
// touches nothing on the photo, so it is deliberately not an Undo step.
const applyStyle = (patch: Partial<TopoObject['style']>, { coalesce = null, geometry = null }: UpdateOptions & { geometry?: Partial<TopoObject['geometry']> | null } = {}) => {
    if (editorMutationLocked()) return;
    const object = selectedObject();
    if (!object && !inspectorType()) return;
    if (object) {
        updateSelected({
            style: { ...object.style, ...patch },
            ...(geometry ? { geometry: { ...object.geometry, ...geometry } } : {}),
        }, { coalesce });
        return;
    }
    rememberTool(inspectorType() as string, { style: patch });
};

const editorEventContext = (event: Event) => {
    // The upload dialog is modal: nothing typed while it is open may arm a
    // tool or edit the photo behind it, even with focus left on the page.
    if (ui.imgbbDialog.open) return { editing: true, editorScoped: false };
    const path = typeof event.composedPath === 'function'
        ? event.composedPath()
        : [event.target];
    const active = document.activeElement;
    const editing = ([...path, active] as (HTMLElement | null)[]).some(node => {
        if (!node || node.nodeType !== 1) return false;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) return true;
        return node.isContentEditable === true
            || node.closest?.('[contenteditable]:not([contenteditable="false"])');
    });
    const target = event.target;
    const editorScoped = !ui.editorView.hidden && (
        (target instanceof Node && ui.editorView.contains(target))
        || (([document, document.body, document.documentElement] as unknown[]).includes(target)
            && (!active || active === document.body || active === document.documentElement
                || ui.editorView.contains(active)))
    );
    return { editing, editorScoped };
};

// Clipboard events keep browser copy/paste commands working without adding
// clipboard permissions. Only the selected annotation leaves the editor.
const ANNOTATION_CLIPBOARD_KIND = 'better-peakbagger-annotation';
const MAX_ANNOTATION_CLIPBOARD_LENGTH = 1024 * 1024;
let lastAnnotationPaste: { text: string; count: number; localId: string } | null = null;

const annotationClipboardAvailable = (event: Event) => {
    const { editing, editorScoped } = editorEventContext(event);
    return project && editorScoped && !editing && activeTool === 'select'
        && !editorMutationLocked() && !routeSession && !drawingSession && !dragSession && !panSession;
};

const onAnnotationCopy = (event: ClipboardEvent) => {
    if (!annotationClipboardAvailable(event) || !event.clipboardData) return;
    const object = selectedObject();
    if (!object) return;
    try {
        event.clipboardData.setData('text/plain', JSON.stringify({
            kind: ANNOTATION_CLIPBOARD_KIND, version: 1, object,
        }));
    } catch { return; }
    event.preventDefault();
    lastAnnotationPaste = null;
    setEditorStatus(`${toolName(object.type)} copied. Paste to add another.`);
};

const onAnnotationPaste = (event: ClipboardEvent) => {
    if (!annotationClipboardAvailable(event) || !event.clipboardData) return;
    let text;
    let payload;
    try {
        text = event.clipboardData.getData('text/plain');
        if (!text || text.length > MAX_ANNOTATION_CLIPBOARD_LENGTH) return;
        payload = JSON.parse(text);
    } catch { return; }
    if (payload?.kind !== ANNOTATION_CLIPBOARD_KIND || payload.version !== 1) return;
    event.preventDefault();
    // Validate untrusted clipboard data through the project model before using
    // its geometry. This also enforces the target project's object/point limits.
    const validated = Project.addObject(project, { ...payload.object, id: crypto.randomUUID() });
    if (!validated) {
        toast('That annotation cannot be pasted into this photo.');
        return;
    }
    const object = validated.objects.at(-1);
    const count = lastAnnotationPaste?.text === text && lastAnnotationPaste!.localId === project!.localId
        ? lastAnnotationPaste!.count + 1 : 1;
    const offset = 24 * count;
    const copy = { ...object, geometry: translatedGeometry(object as unknown as TopoObject, offset, offset) };
    // At a coordinate boundary, preserve the original position rather than
    // dropping a valid annotation because the small paste offset does not fit.
    const next = Project.addObject(project, copy) || validated;
    selectedId = object!.id;
    selectedVertex = null;
    if (!setProject(next)) return;
    lastAnnotationPaste = { text, count, localId: project!.localId };
    ui.viewport.focus({ preventScroll: true });
    setEditorStatus(`${toolName(object!.type)} pasted. Use the arrow keys to move it.`);
};

const duplicateSelected = () => {
    if (editorMutationLocked()) return;
    const object = selectedObject();
    if (!object) return;
    const copy = structuredClone(object);
    copy.id = crypto.randomUUID();
    copy.geometry = translatedGeometry(copy, 24, 24) as TopoObject['geometry'];
    const next = Project.addObject(project, copy);
    if (!next) return;
    selectedId = copy.id;
    selectedVertex = null;
    setProject(next);
};

const insertRoutePoint = () => {
    const route = selectedObject();
    if (editorMutationLocked() || route?.type !== 'route') return;
    const points = route.geometry.points;
    const index = selectedVertex == null ? points.length - 2
        : Math.min(selectedVertex, points.length - 2);
    const midpoint = points[index].map((value, axis) => (value + points[index + 1][axis]) / 2) as TopoPoint;
    const nextPoints = [...points];
    nextPoints.splice(index + 1, 0, midpoint);
    const next = Project.updateObject(project, route.id, {
        geometry: { points: nextPoints, controls: [] },
    });
    if (!next) { setEditorStatus('This route cannot hold another point.'); return; }
    selectedVertex = index + 1;
    setProject(next);
    setEditorStatus(`Point ${selectedVertex + 1} inserted. Drag it or use the arrow keys to move it.`);
};

const removeRoutePoint = () => {
    const route = selectedObject();
    if (editorMutationLocked() || route?.type !== 'route' || selectedVertex == null) return;
    const points = route.geometry.points;
    if (points.length <= 2) {
        setEditorStatus('A route needs at least two points.');
        return;
    }
    const focusedPoint = ui.routePointList.contains(document.activeElement);
    const removed = selectedVertex;
    const nextPoints = [...points];
    nextPoints.splice(removed, 1);
    const next = Project.updateObject(project, route.id, {
        geometry: { points: nextPoints, controls: [] },
    });
    if (!next) return;
    selectedVertex = Math.min(removed, points.length - 2);
    setProject(next);
    if (focusedPoint) {
        ui.routePointList.querySelector<HTMLElement>(`[data-vertex="${selectedVertex}"]`)?.focus();
    }
    setEditorStatus(`Point ${removed + 1} removed. The route has ${points.length - 1} points.`);
};

const deleteSelected = () => {
    if (editorMutationLocked()) return;
    if (!selectedId) return;
    const listButtons = [...ui.annotationList.querySelectorAll<HTMLElement>('[data-object-id]')];
    const focusedIndex = listButtons.indexOf(document.activeElement as HTMLElement);
    const next = Project.removeObjects(project, [selectedId]);
    selectedId = null;
    selectedVertex = null;
    setProject(next);
    if (focusedIndex >= 0) {
        const remaining = [...ui.annotationList.querySelectorAll<HTMLElement>('[data-object-id]')];
        (remaining[Math.min(focusedIndex, remaining.length - 1)] || ui.addAtCenter).focus();
    }
};

const nudgeSelected = (dx: number, dy: number) => {
    if (editorMutationLocked()) return;
    const object = selectedObject();
    if (!object) return;
    if (object.type === 'route' && Number.isInteger(selectedVertex)) {
        const points = object.geometry.points.map((point: TopoPoint, index: number) => index === selectedVertex
            ? [point[0] + dx, point[1] + dy] as TopoPoint
            : point);
        updateSelected({ geometry: { points, controls: [] } as unknown as TopoObject['geometry'] }, {
            coalesce: `vertex-nudge-${selectedVertex}`,
        });
        return;
    }
    updateSelected({ geometry: translatedGeometry(object, dx, dy) as TopoObject['geometry'] }, { coalesce: 'nudge' });
};

const loadBundle = async (bundle: PhotoBundle) => {
    if (!bundle?.photo || !bundle.project || !bundle.original) {
        toast('The editable original is not available on this device.');
        return false;
    }
    const bitmap = await decodeBlob(bundle.original);
    if (!Project.matchingImageDimensions(bundle.project.image, bundle.photo.source)
        || !Project.matchingImageDimensions(bundle.project.image, bitmap)) {
        bitmap.close?.();
        toast(DIMENSION_MISMATCH_MESSAGE);
        return false;
    }
    const thumbnail = bundle.thumbnail || await makeThumbnail(bitmap);
    closeSource();
    sourceBitmap = bitmap;
    project = bundle.project as unknown as TopoProject;
    photo = bundle.photo;
    originalBlob = bundle.original;
    thumbnailBlob = thumbnail;
    clearTimeout(autosaveTimer!);
    autosaveTimer = null;
    // A library bundle is already durable. Advance the generation so a write
    // started by the previously open photo cannot publish its completion into
    // this editor state or replace this status with its own result.
    draftRevision += 1;
    draftDirty = false;
    ui.saveConflictedDraft.hidden = true;
    history = [];
    future = [];
    selectedId = null;
    selectedVertex = null;
    ui.title.value = photo!.title;
    ui.caption.value = photo!.caption || '';
    setSourceDisplay(originalBlob!);
    ui.editorEmpty.hidden = true;
    ui.editorWorkspace.hidden = false;
    initializeUploadSettings();
    renderProject();
    setSaveStatus('Saved on this device');
    return true;
};

const chooseFile = async (file: File | undefined) => {
    if (busy || !file) return;
    if (LOCAL_PHOTO_ID) {
        toast('Finish this report photo first. Open Photo Topos from the extension to start another image.');
        return;
    }
    if (file.size <= 0) {
        toast('That file is empty.');
        return;
    }
    if (file.size > MAX_ENCODED_SOURCE_BYTES) {
        toast(
            `That source file is ${formatBytes(file.size)}. Photo Topos can process and retain `
            + 'source files up to 128 MiB. Your original file was not changed; choose a smaller '
            + 'or cropped copy.',
            {
                action: 'Choose smaller photo',
                onAction: () => {
                    dismissToast();
                    ui.file.value = '';
                    ui.file.click();
                },
                duration: 0,
            },
        );
        return;
    }
    settleEditorGestures();
    setBusy(true, 'Reading photo…');
    let shouldPersist = false;
    let bitmap = null;
    let phase = 'storage';
    try {
        if (!await settleOutgoingDraft()) return;
        await preflightSourceStorage(file.size);
        phase = 'decode';
        bitmap = await decodeBlob(file);
        if (!bitmap.width || !bitmap.height) throw new Error('The image has no dimensions.');
        if (!Project.cleanImageDimensions(bitmap)) throw new RangeError(IMAGE_LIMIT_MESSAGE);
        phase = 'hash';
        const sourceSha256 = await Renderer.sha256(file);
        let nextProject = Project.createProject({
            localId: crypto.randomUUID(),
            width: bitmap.width,
            height: bitmap.height,
            sourceSha256,
        });
        if (!nextProject) throw new RangeError(IMAGE_LIMIT_MESSAGE);
        uploadFormat = Project.sourceExportMime(file.type) ? 'original' : 'jpeg';
        jpegQuality = Project.DEFAULT_JPEG_QUALITY;
        nextProject = Project.cleanProject({
            ...nextProject,
            export: Project.resolveExportSettings({
                format: uploadFormat,
                sourceMime: file.type,
                jpegQuality,
            } as never),
        });
        if (!nextProject) throw new RangeError(IMAGE_LIMIT_MESSAGE);
        phase = 'thumbnail';
        const nextThumbnail = await makeThumbnail(bitmap);
        closeSource();
        sourceBitmap = bitmap;
        bitmap = null;
        originalBlob = file;
        thumbnailBlob = nextThumbnail as Blob;
        project = nextProject as unknown as TopoProject;
        photo = null;
        ui.saveConflictedDraft.hidden = true;
        selectedId = null;
        selectedVertex = null;
        history = [];
        future = [];
        ui.title.value = defaultTitle(file.name);
        ui.caption.value = '';
        setSourceDisplay(file);
        ui.editorEmpty.hidden = true;
        ui.editorWorkspace.hidden = false;
        initializeUploadSettings();
        renderProject();
        // The title is filled from the file name and the caption is
        // optional, so the draft is already valid — autosave it rather than
        // waiting for an edit that may never come.
        setSaveStatus('Not saved yet');
        setEditorStatus(SOURCE_IMAGE_URL && RETURN_TOKEN
            ? 'Photo stays local until you choose Upload and replace.'
            : 'Photo stays local until you choose Upload and insert.');
        shouldPersist = true;
        ui.caption.focus();
    } catch (error) {
        bitmap?.close?.();
        const message = error instanceof PhotoSourcePreparationError || error instanceof RangeError
            ? error.message
            : phase === 'hash'
                ? 'Better Peakbagger could not verify this photo for local storage. '
                    + 'Your original file was not changed.'
                : phase === 'decode'
                    ? 'This browser could not decode that image. Your original file was not changed.'
                    : 'Better Peakbagger could not prepare a local editable copy. '
                        + 'Your original file was not changed.';
        toast(message, { duration: 9000 });
    } finally {
        setBusy(false);
        if (shouldPersist) schedulePersist();
    }
};

const transferHasFiles = (transfer: DataTransfer | null) => {
    if (!transfer) return false;
    if ([...(transfer.types || [])].includes('Files')) return true;
    return [...(transfer.items || [])].some(item => item.kind === 'file');
};

const photoFromTransfer = (transfer: DataTransfer | null) => {
    if (!transfer) return null;
    const item = [...(transfer.items || [])].find(candidate =>
        candidate.kind === 'file'
        && (!candidate.type || candidate.type.startsWith('image/')));
    const itemFile = item?.getAsFile?.();
    if (itemFile) return itemFile;
    return [...(transfer.files || [])].find(file =>
        !file.type || file.type.startsWith('image/')) || null;
};

const resetPhotoDrag = () => {
    photoDragDepth = 0;
    ui.editorEmpty.classList.remove('is-photo-drag-over');
};

const emptyEditorAcceptsPhoto = () =>
    !ui.editorEmpty.hidden && !ui.editorView.hidden;

const onPhotoDragEnter = (event: DragEvent) => {
    if (!emptyEditorAcceptsPhoto() || !transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    photoDragDepth += 1;
    ui.editorEmpty.classList.add('is-photo-drag-over');
};

const onPhotoDragOver = (event: DragEvent) => {
    if (!emptyEditorAcceptsPhoto() || !transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
};

const onPhotoDragLeave = (event: DragEvent) => {
    if (!ui.editorEmpty.classList.contains('is-photo-drag-over')) return;
    event.preventDefault();
    photoDragDepth = Math.max(0, photoDragDepth - 1);
    if (!photoDragDepth) resetPhotoDrag();
};

const onPhotoDrop = (event: DragEvent) => {
    if (!emptyEditorAcceptsPhoto() || !transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    resetPhotoDrag();
    if (busy) return;
    const file = photoFromTransfer(event.dataTransfer);
    if (!file) {
        toast('Drop an image file to create a photo topo.');
        return;
    }
    void chooseFile(file);
};

const onPhotoPaste = (event: ClipboardEvent) => {
    if (busy || ui.imgbbDialog.open || !emptyEditorAcceptsPhoto()) return;
    const file = photoFromTransfer(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    void chooseFile(file);
};

const saveLocalAndReturn = async () => {
    if (busy || localPhotoReturned || !project || !sourceBitmap) return;
    cancelDrawing();
    if (dragSession) endDrag();
    if (routeSession) finishRoute(false);
    setBusy(true, 'Saving photo locally…');
    try {
        if (!await persistDraft({ required: true })) return;
        const exported = await Renderer.exportProject({ project, source: sourceBitmap } as never);
        if (exported.bytes > PendingPhoto.MAX_BYTES) {
            throw new Error('This edited image is too large to return. Choose JPEG or a lower quality and save again.');
        }
        const response = await send({
            type: 'PHOTO_INSERT_COMMIT', returnToken: RETURN_TOKEN,
            localPhotoId: photo!.localId, url: PendingPhoto.url(photo!.localId), alt: photo!.alt, caption: photo!.caption || '',
            dataUrl: await PendingPhoto.toDataUrl(exported.blob),
        });
        if (!response?.ok) throw new Error(response?.error?.message || 'The report is no longer available. Your photo is saved on this device.');
        localPhotoReturned = true;
        setEditorStatus('Photo updated in the report. It will upload when you save the TR.');
        toast('Saved to the report. You can close this tab.');
    } catch (error) {
        toast((error as Error).message, { duration: 0 });
    } finally { setBusy(false); }
};

const uploadAndInsert = async () => {
    const outcome = { reached: false, keyRejected: false, needsKey: false };
    uploadInFlight = true;
    try {
        await runUpload(outcome);
    } finally {
        uploadInFlight = false;
        renderFinish();
        await settlePendingKey(outcome);
        if (outcome.keyRejected) openKeyDialog('ImgBB didn’t accept that key. Check it and try again.');
        else if (outcome.needsKey) openKeyDialog();
    }
};

const runUpload = async (outcome: { reached: boolean; keyRejected: boolean; needsKey: boolean }) => {
    if (LOCAL_PHOTO_ID) return saveLocalAndReturn();
    if (busy || !project || !sourceBitmap) return;
    if (['uploading', 'outcome-unknown'].includes(photo?.remote.state as string)) {
        toast('An earlier upload may have reached ImgBB. Check your ImgBB account before uploading again.', { duration: 0 });
        return;
    }
    if (PUBLISHED_STATES.includes(photo?.remote.state as string)) {
        toast('This photo is already on ImgBB. Use “Edit as new version” in the library to change it.');
        return;
    }
    cancelDrawing();
    if (dragSession) endDrag();
    if (routeSession) finishRoute(false);
    setBusy(true, 'Saving upload snapshot…');
    let operation: PhotoOperation | null = null;
    let uploadingPhoto: TopoPhoto | null = null;
    let providerResponse: { remote: TopoRemote; deleteUrl: unknown } | null = null;
    let committedPhoto: TopoPhoto | null = null;
    let uploadSnapshot: { project: TopoProject; photo: TopoPhoto; sourceBitmap: ImageBitmap | null; originalBlob: Blob | null; reportImageWidth: number | null } | null = null;
    try {
        if (!await persistDraft({ required: true })) return;
        clearTimeout(autosaveTimer!);
        autosaveTimer = null;
        const snapshotProject = Project.cleanProject(project);
        const snapshotPhoto = Library.cleanPhoto(photo);
        if (!snapshotProject || !snapshotPhoto || snapshotProject.localId !== snapshotPhoto.localId) {
            toast('The saved photo changed before upload could begin. Try again.');
            return;
        }
        uploadSnapshot = {
            project: structuredClone(snapshotProject) as unknown as TopoProject,
            photo: structuredClone(snapshotPhoto),
            sourceBitmap,
            originalBlob,
            reportImageWidth,
        };
        if (!await hasPermission()) {
            toast('Allow Better Peakbagger to reach api.imgbb.com, then choose Upload again.');
            return;
        }
        const key = await leaseCredential();
        if (!key) {
            outcome.needsKey = true;
            return;
        }
        setEditorStatus('Preparing image…');
        // Deliberately no local size check: the ceiling belongs to the ImgBB
        // account, not to this extension, and it says so in its own rejection.
        const exported = await prepareSnapshotExport(uploadSnapshot);
        ui.exportSummary.textContent = `${formatBytes(exported.bytes)} ${exported.mime.replace('image/', '').toUpperCase()}`
            + ` · ${exported.width} × ${exported.height}`;
        const exportMetadata = {
            mime: exported.mime,
            bytes: exported.bytes,
            width: exported.width,
            height: exported.height,
            sha256: exported.sha256,
        };
        uploadingPhoto = Library.beginUpload(uploadSnapshot.photo, exportMetadata);
        operation = {
            operationId: crypto.randomUUID(),
            localId: uploadSnapshot.photo.localId,
            state: 'request-started',
            export: exportMetadata,
            returnToken: RETURN_TOKEN || null,
            displayWidth: ReportSize.displayWidth(
                exportMetadata.width,
                uploadSnapshot.reportImageWidth,
            ),
            updatedAt: new Date().toISOString(),
        };
        ({ photo: uploadingPhoto, operation } = await store.beginUploadOperation({
            photo: uploadingPhoto,
            operation,
        }));
        photo = uploadingPhoto;
        setEditorStatus('Uploading to ImgBB…');
        // From here ImgBB may have seen the key, even if the reply never arrives.
        outcome.reached = true;
        if (pendingKey) pendingKeyReachedProvider = true;
        providerResponse = await ImgbbClient.upload({
            fetch: globalThis.fetch.bind(globalThis),
            key,
            blob: exported.blob,
            name: uploadSnapshot.photo.title,
        } as never) as unknown as { remote: TopoRemote; deleteUrl: unknown };
        operation = {
            ...operation,
            state: 'response-received',
            remote: providerResponse!.remote,
            deleteUrl: providerResponse!.deleteUrl,
            updatedAt: new Date().toISOString(),
        } as PhotoOperation;
        await store.putOperation(operation);
        setEditorStatus('Saving to library…');
        photo = Library.completeUpload(uploadingPhoto, exportMetadata, providerResponse!.remote as never);
        ({ photo, operation } = await store.commitUploadOperation({
            photo,
            operationId: operation!.operationId,
        }));
        committedPhoto = photo;
        project = structuredClone(uploadSnapshot.project) as unknown as TopoProject;
        ui.title.value = uploadSnapshot.photo.title;
        ui.caption.value = uploadSnapshot.photo.caption || '';
        selectedId = null;
        selectedVertex = null;
        routeSession = null;
        dragSession = null;
        history = [];
        future = [];
        renderProject();
        if (RETURN_TOKEN) setEditorStatus('Inserting into report…');
        const finished = await UploadTransaction.finishCommittedUpload({
            store,
            operation,
            photo,
            insert: ({ returnToken, photo: inserting }: { returnToken: string; photo: TopoPhoto & { remote: TopoRemote } }) => {
                const displayWidth = operation!.displayWidth;
                return send({
                    type: 'PHOTO_INSERT_COMMIT',
                    returnToken,
                    localPhotoId: inserting.localId,
                    url: inserting.remote.url,
                    alt: inserting.alt, caption: inserting.caption || '',
                    ...(displayWidth === null ? {} : { displayWidth }),
                });
            },
        } as never) as { photo: TopoPhoto; inserted?: boolean };
        photo = finished.photo;
        committedPhoto = photo;
        if (RETURN_TOKEN && finished.inserted) { insertionConfirmed = true; insertedLocalId = photo!.localId; }
        if (RETURN_TOKEN) {
            setEditorStatus('Uploaded and inserted. You can close this tab.');
            toast('Photo uploaded and inserted into the report. You can close this tab.');
        } else {
            setEditorStatus('Uploaded to ImgBB and saved in the library.');
            toast('Photo uploaded to ImgBB.');
        }
        notifyBackupChanged();
        await renderLibrary();
    } catch (error) {
        if (committedPhoto) {
            photo = committedPhoto;
            if (uploadSnapshot) {
                project = structuredClone(uploadSnapshot.project) as unknown as TopoProject;
                ui.title.value = uploadSnapshot.photo.title;
                ui.caption.value = uploadSnapshot.photo.caption || '';
                renderProject();
            }
            const message = error instanceof UploadTransaction.CommittedUploadError
                ? error.message
                : RETURN_TOKEN
                    ? 'The photo was uploaded and saved in the library, but report insertion is still pending. '
                        + 'You can insert it from the photo library.'
                    : 'The photo was uploaded and saved in the library, but local cleanup is still pending.';
            setEditorStatus(message);
            showUrlRecovery(`${message} The public image URL is below.`, (committedPhoto.remote as TopoRemote).url!);
            notifyBackupChanged();
            await renderLibrary();
            return;
        }
        const publicFailure = error instanceof Store.PhotoStoreConflictError
            ? { ambiguous: !!providerResponse, message: error.message }
            : ImgbbClient.publicError(error);
        // ImgBB's invalid-key reply (its code 100) is the one refusal that
        // says the key, not the image, is wrong. Only a key just typed into the
        // dialog goes back there; a saved key keeps the ordinary message.
        outcome.keyRejected = !!pendingKey && error instanceof ImgbbClient.ImgbbError
            && (error as { code?: string }).code === 'not-configured';
        if ((publicFailure.ambiguous || providerResponse) && uploadingPhoto) {
            photo = Library.markOutcomeUnknown(uploadingPhoto);
            photo = await store.putPhoto(photo).catch(() => photo);
        } else if (uploadingPhoto && operation?.state === 'request-started') {
            const retryable = Library.resetUpload(uploadingPhoto);
            photo = await store.resetUploadOperation({
                photo: retryable,
                operationId: operation.operationId,
            }).catch(() => uploadingPhoto);
        }
        setEditorStatus(outcome.keyRejected ? 'Check the ImgBB key and try again.' : publicFailure.message);
        if (outcome.keyRejected) {
            // The dialog explains it; nothing was stored, so no other message.
        } else if (providerResponse?.remote?.url) {
            showUrlRecovery(
                'ImgBB accepted the image, but Better Peakbagger could not finish cataloging it. '
                + 'Save the public image URL below.',
                providerResponse.remote.url,
            );
        } else {
            toast(publicFailure.message, { duration: 9000 });
        }
        notifyBackupChanged();
    } finally {
        setBusy(false);
    }
};

const recoverOperations = async () => {
    const legacy = await store.recoverOrphanedUploads(new Date().toISOString());
    const operations = await store.getOperations();
    let changed = legacy.recovered > 0;
    for (let operation of operations) {
        const bundle = await store.getBundle(operation.localId);
        if (!bundle.photo) {
            await store.deleteOperation(operation.operationId);
            continue;
        }
        try {
            if (operation.state === 'request-started' && bundle.photo.remote.state === 'uploading') {
                bundle.photo = await store.putPhoto(Library.markOutcomeUnknown(bundle.photo));
                changed = true;
            }
            if (operation.state === 'response-received') {
                const alreadyCommitted = ['uploaded', 'unreachable'].includes(bundle.photo!.remote.state);
                const completed = alreadyCommitted
                    ? bundle.photo
                    : Library.completeUpload(
                        bundle.photo,
                        operation.export,
                        operation.remote,
                        operation.updatedAt,
                    );
                if (completed) {
                    ({ photo: bundle.photo, operation } = await store.commitUploadOperation({
                        photo: completed,
                        operationId: operation.operationId,
                    }));
                    changed = true;
                }
            }
            if (operation.state === 'catalog-committed'
                && ['uploaded', 'unreachable'].includes(bundle.photo!.remote.state)) {
                await UploadTransaction.finishCommittedUpload({
                    store,
                    operation,
                    photo: bundle.photo,
                    insert: ({ returnToken, photo: inserting }: { returnToken: string; photo: TopoPhoto & { remote: TopoRemote } }) => {
                        const displayWidth = Object.hasOwn(operation, 'displayWidth')
                            ? operation.displayWidth
                            : ReportSize.displayWidth(inserting.export!.width, reportImageWidth);
                        return send({
                            type: 'PHOTO_INSERT_COMMIT',
                            returnToken,
                            localPhotoId: inserting.localId,
                            url: inserting.remote.url,
                            alt: inserting.alt, caption: inserting.caption || '',
                            ...(displayWidth === null ? {} : { displayWidth }),
                        });
                    },
                } as never);
                changed = true;
            }
        } catch {
        // Keep the journal for an explicit recovery attempt.
        }
    }
    if (changed) notifyBackupChanged();
};

const statusLabels = (item: TopoPhoto) => {
    const remote = item.remote.state === 'outcome-unknown' ? 'Upload uncertain'
        : item.remote.state === 'unreachable' ? 'Image unreachable'
            : item.remote.state === 'uploaded' ? 'Uploaded'
                : item.remote.state === 'uploading' ? 'Uploading'
                    : 'Local draft';
    const use = item.references.length ? 'In report' : item.remote.state === 'uploaded' ? 'Not inserted' : null;
    const backup = item.backup.state === 'pending' ? 'Backup pending'
        : item.backup.state === 'failed' ? 'Backup failed'
            : item.backup.state === 'current' ? 'Backed up' : null;
    return [remote, use, backup].filter(Boolean);
};

const makeButton = (label: string, handler: ClickHandler, className = 'quiet-button') => {
    const button = element<HTMLButtonElement>('button', `panel-button ${className === 'secondary-button' ? 'secondary' : 'quiet'} ${className}`, label);
    button.type = 'button';
    button.addEventListener('click', handler as EventListener);
    return button;
};

const runLibraryAction = async (control: HTMLButtonElement, operation: LibraryOperation, failureMessage: string, { retry = false } = {}) => {
    if (control?.disabled || control?.getAttribute('aria-busy') === 'true') return;
    const hadFocus = document.activeElement === control;
    if (control) {
        // Keep the action focusable while its storage transaction is pending.
        // Native disabling drops browser focus before a library redraw can own it.
        control.setAttribute('aria-disabled', 'true');
        control.setAttribute('aria-busy', 'true');
    }
    try {
        await operation(control);
    } catch {
        toast(failureMessage, {
            duration: retry ? 0 : 9000,
            ...(retry ? {
                action: 'Undo',
                onAction: event => void runLibraryAction(event.currentTarget, operation, failureMessage, { retry }),
            } : {}),
        });
    } finally {
        if (control) {
            control.removeAttribute('aria-disabled');
            control.removeAttribute('aria-busy');
            if (hadFocus && control.isConnected && document.activeElement === document.body) {
                control.focus({ preventScroll: true });
            }
        }
    }
};

const makeLibraryButton = (label: string, operation: LibraryOperation, failureMessage: string, className?: string) => makeButton(label,
    event => void runLibraryAction(event.currentTarget, operation, failureMessage), className);

const insertFromLibrary = async (item: TopoPhoto, control: HTMLButtonElement | null = null) => {
    if (LOCAL_PHOTO_ID) return;
    if (!RETURN_TOKEN) {
        await copyTextWithFallback((item.remote as TopoRemote).url!, { control });
        return;
    }
    const displayWidth = ReportSize.displayWidth(item.export!.width, reportImageWidth);
    const inserted = await send({
        type: 'PHOTO_INSERT_COMMIT',
        returnToken: RETURN_TOKEN,
        localPhotoId: item.localId,
        url: (item.remote as TopoRemote).url!,
        alt: item.alt, caption: item.caption || '',
        ...(displayWidth === null ? {} : { displayWidth }),
    });
    if (!inserted?.ok) {
        toast(inserted?.error?.message || 'The image could not be inserted.');
        return;
    }
    const referenced = Library.addReference(item, {
        kind: inserted.identity?.aid ? 'ascent' : 'ascent-draft',
        cid: inserted.identity?.cid ?? null,
        aid: inserted.identity?.aid ?? null,
        pid: inserted.identity?.pid ?? null,
        insertedAt: new Date().toISOString(),
    });
    try {
        await store.putPhoto(referenced);
    } catch (error) {
        if (error instanceof Store.PhotoStoreConflictError) {
            toast('The photo was inserted, but its library record changed in another tab. Reload the library.', {
                duration: 9000,
            });
            await renderLibrary();
            return;
        }
        toast('The photo was inserted, but its library record could not be saved. Reload the library before inserting again.', {
            duration: 9000,
        });
        return;
    }
    notifyBackupChanged();
    // The token is spent either way; the slot says Inserted only for this photo.
    insertedLocalId = item.localId;
    insertionConfirmed = true;
    renderFinish();
    toast('Photo inserted into the report. You can close this tab.');
    await renderLibrary();
};

const editAsNewVersion = async (item: TopoPhoto, control: HTMLButtonElement | null = null) => {
    if (busy || newVersionTransaction) return;
    if (!canEditReportPhoto(item)) return;
    const owner = {};
    newVersionTransaction = owner;
    settleEditorGestures();
    setBusy(true, 'Opening photo…');
    if (control) {
        control.disabled = true;
        control.setAttribute('aria-busy', 'true');
    }
    let decodedBitmap = null;
    let committed = false;
    let opened = false;
    try {
        if (!await settleOutgoingDraft()) return;
        const latest = LOCAL_PHOTO_ID ? item : Library.latestPhotos(await store.listPhotos())
            .find(candidate => candidate.source.sha256 === item.source.sha256) || item;
        const bundle = await store.getBundle(latest.localId);
        if (!bundle.photo || !bundle.original || !bundle.project) {
            toast('The original photo is not available on this device.');
            return;
        }
        if (bundle.photo.remote.state === 'draft') {
            if (!await loadBundle(bundle)) throw new Error('saved draft could not be loaded');
            opened = true;
            return;
        }
        const localId = crypto.randomUUID();
        const now = new Date().toISOString();
        const nextProject = Project.cleanProject({
            ...bundle.project,
            localId,
            updatedAt: now,
        });
        const nextPhoto = Library.createDraft({
            localId,
            title: bundle.photo.title,
            alt: bundle.photo.alt, caption: bundle.photo.caption || '',
            source: bundle.photo.source,
            parentLocalId: bundle.photo.localId,
            now,
        } as never);
        let thumbnail = bundle.thumbnail;
        if (!thumbnail) {
            decodedBitmap = await decodeBlob(bundle.original);
            thumbnail = await makeThumbnail(decodedBitmap);
        }
        await store.putDraft({
            photo: nextPhoto,
            project: nextProject,
            original: bundle.original,
            thumbnail,
        });
        committed = true;
        notifyBackupChanged();
        const savedBundle = await store.getBundle(localId);
        if (!await loadBundle(savedBundle)) throw new Error('saved draft could not be loaded');
        opened = true;
        if (await store.pruneSupersededVersions()) notifyBackupChanged();
        toast('Editing a new version. The existing image will stay unchanged.');
    } catch {
        if (committed) {
            await renderLibrary();
            toast('The new version was saved, but the editor could not open it. Reopen it from the library.', {
                duration: 9000,
            });
        } else {
            toast('A new version could not be saved. Try again from the library.', { duration: 9000 });
        }
    } finally {
        decodedBitmap?.close?.();
        if (newVersionTransaction === owner) newVersionTransaction = null;
        setBusy(false);
        if (opened) setEditorStatus(LOCAL_PHOTO_ID
            ? 'Edits stay on this device. Save and return to update the TR.'
            : 'Photo opened. Edits stay on this device.');
        if (opened || draftDirty) setView('editor');
        if (control) {
            control.disabled = false;
            control.setAttribute('aria-busy', 'false');
        }
    }
};

// The return leg of Download project. A bundle whose id is still free is
// reunited with its own record, so a restored GitHub catalog entry, its report
// references, and its public URL all find their pixels again. A bundle whose id
// is already here becomes a new local draft instead: two catalog records
// claiming one published ImgBB asset could each be "removed" independently, and
// the second removal would look like it had freed something it had not.
const importProject = async (file: File | undefined) => {
    if (busy || !file) return;
    // The library view has no status line, so the toast carries the progress
    // and the result replaces it.
    setBusy(true);
    toast('Reading project bundle…', { duration: 0 });
    try {
        const raw = await Archive.readProjectArchive(file);
        const importedProject = Project.cleanProject(raw.project);
        const imported = Library.cleanPhoto(raw.photo);
        if (!importedProject || !imported || importedProject.localId !== imported.localId) {
            throw new Archive.ArchiveError('That project bundle is not a readable Better Peakbagger project.');
        }
        if (!Project.matchingImageDimensions(importedProject.image, imported.source)) {
            throw new Archive.ArchiveError(DIMENSION_MISMATCH_MESSAGE);
        }
        const sha256 = await Renderer.sha256(raw.original);
        if (sha256 !== importedProject.image.sourceSha256 || sha256 !== imported.source.sha256) {
            throw new Archive.ArchiveError('That bundle’s image does not match its project.');
        }
        const bitmap = await decodeBlob(raw.original);
        let thumbnail;
        try {
            if (!Project.matchingImageDimensions(importedProject.image, bitmap)) {
                throw new Archive.ArchiveError(DIMENSION_MISMATCH_MESSAGE);
            }
            thumbnail = await makeThumbnail(bitmap);
        } finally {
            bitmap.close?.();
        }

        const existing = (await store.getBundle(imported.localId)).photo;
        const now = new Date().toISOString();
        const localId = existing ? crypto.randomUUID() : imported.localId;
        const nextPhoto = existing
            ? Library.createDraft({
                localId,
                title: `${imported.title} (imported)`.slice(0, Library.TITLE_LIMIT),
                alt: imported.alt, caption: imported.caption || '',
                source: imported.source,
                parentLocalId: imported.localId,
                now,
            } as never)
            : Library.cleanPhoto({
                ...imported,
                revision: 0,
                updatedAt: now,
                // This device has not backed the record up, whatever the
                // bundle recorded on the device that wrote it.
                backup: { state: 'off', signature: null, backedUpAt: null, commitUrl: null },
                assets: {
                    originalRetained: true,
                    projectRetained: true,
                    thumbnailRetained: true,
                },
                deletedAt: null,
            });
        await store.putBundle({
            photo: nextPhoto,
            project: Project.cleanProject({ ...importedProject, localId, updatedAt: now }),
            original: raw.original,
            thumbnail,
        });
        notifyBackupChanged();
        await renderLibrary();
        toast(existing
            ? 'Imported as a new local draft, because that photo is already in this library.'
            : `Imported “${nextPhoto!.title}”.`);
    } catch (error) {
        toast(error instanceof Archive.ArchiveError
            ? error.message
            : 'That project bundle could not be imported.', { duration: 9000 });
    } finally {
        ui.importProject.value = '';
        setBusy(false);
    }
};

const downloadProject = async (item: TopoPhoto) => {
    const bundle = await store.getBundle(item.localId);
    if (!bundle.project || !bundle.original) {
        toast('The editable project is not available on this device.');
        return;
    }
    const archiveBytes = Archive.projectArchiveSize({
        project: bundle.project,
        photo: bundle.photo,
        original: bundle.original,
    });
    if (archiveBytes > Archive.MAX_ARCHIVE_BYTES) {
        toast(
            `This project needs ${formatBytes(archiveBytes)} to download, above the 40 MiB project limit. `
            + 'Create a new topo from a smaller or cropped source image.',
            { duration: 9000 },
        );
        return;
    }
    if (!confirm(
        'This project bundle includes the original file and any metadata it contains. Download it?',
    )) return;
    let blob;
    try {
        blob = await Archive.createProjectArchive({
            project: bundle.project,
            photo: bundle.photo,
            original: bundle.original,
        });
    } catch (error) {
        toast(error instanceof Archive.ArchiveError
            ? error.message
            : 'This project could not be downloaded.', { duration: 9000 });
        return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${item.localId}.bpb-photo`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const moveToDeleted = async (item: TopoPhoto) => {
    if (!confirm(
        `Move “${item.title}” to Recently Deleted? It is restorable with editing data for 30 days. `
        + 'Its ImgBB image and report URLs will not change.',
    )) return;
    let deleted;
    try {
        deleted = await store.putPhoto(Library.markDeleted(item));
    } catch (error) {
        if (!(error instanceof Store.PhotoStoreConflictError)) throw error;
        toast(error.message, { duration: 9000 });
        await renderLibrary();
        return;
    }
    notifyBackupChanged();
    scheduleLibraryMaintenance();
    undoDeleted = item;
    toast('Moved to Recently Deleted. Restorable with editing data for 30 days. '
        + 'The remote image was not deleted.', {
        action: 'Undo',
        onAction: event => void runLibraryAction(event.currentTarget, async (control: HTMLButtonElement) => {
            try {
                await store.restorePhoto(Library.restoreDeleted(deleted));
            } catch (error) {
                if (!(error instanceof Store.PhotoStoreConflictError)) throw error;
                toast(error.message, { duration: 9000 });
                await renderLibrary();
                return;
            }
            notifyBackupChanged();
            undoDeleted = null;
            const ownedFocus = document.activeElement === control;
            dismissToast();
            await renderLibrary();
            if (ownedFocus && ([document.body, control] as (Element | null)[]).includes(document.activeElement)) {
                const card = [...ui.libraryList.children].find(candidate => (candidate as HTMLElement).dataset.localId === item.localId);
                ((card?.querySelector('[data-action="remove"]') || libraryFocusFallback()) as HTMLElement).focus({ preventScroll: true });
            }
        }, 'The photo could not be restored. Try Undo again.', { retry: true }),
        duration: 10000,
    });
    await renderLibrary();
};

const restoreLibraryItem = async (item: TopoPhoto) => {
    const recovery = Library.deletedRecovery(item);
    const restoreEditingData = recovery?.editingDataRecoverable === true;
    try {
        await store.restorePhoto(Library.restoreDeleted(item), {
            retainAssets: restoreEditingData,
        });
    } catch (error) {
        if (!(error instanceof Store.PhotoStoreConflictError)) throw error;
        toast(error.message, { duration: 9000 });
        await renderLibrary();
        return;
    }
    notifyBackupChanged();
    toast(restoreEditingData
        ? 'Photo restored with editing data.'
        : 'Photo record restored. Editing data is no longer available on this device.');
    await renderLibrary();
};

const recoveryDate = (value: string) => new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
});

const deletedRecoveryDetails = (item: TopoPhoto) => {
    const recovery = Library.deletedRecovery(item);
    if (!recovery) return null;
    const container = element('div', 'deleted-recovery');
    const dates = element('p', 'deleted-recovery-dates');
    dates.append('Deleted ');
    const deleted = element<HTMLTimeElement>('time', '', recoveryDate(recovery.deletedAt));
    deleted.dateTime = recovery.deletedAt;
    dates.append(deleted, ' · 30-day editing-data deadline ');
    const expires = element<HTMLTimeElement>('time', '', recoveryDate(recovery.expiresAt));
    expires.dateTime = recovery.expiresAt;
    dates.append(expires);
    container.append(dates);

    container.append(element('p', 'deleted-recovery-outcome',
        recovery.editingDataRecoverable
            ? 'Editing data is available if you restore before the deadline.'
            : recovery.editingDataRetained
                ? 'Editing recovery has expired. Restoring will remove the remaining local editing data.'
                : 'Editing data is no longer retained on this device.'));

    const retained = [
        item.assets.originalRetained ? 'original' : '',
        item.assets.projectRetained ? 'project' : '',
        item.assets.thumbnailRetained ? 'thumbnail' : '',
    ].filter(Boolean);
    const remote = item.remote.state === 'uploaded'
        ? 'ImgBB image retained'
        : item.remote.state === 'unreachable'
            ? 'ImgBB image marked unreachable'
            : 'no published image';
    const references = item.references.length
        ? `used in ${item.references.length} report${item.references.length === 1 ? '' : 's'}`
        : 'not used in a report';
    const backup = item.backup.state === 'off'
        ? 'not backed up'
        : `backup ${item.backup.state}`;
    container.append(element('p', 'deleted-recovery-state',
        `Local: ${retained.length ? `${retained.join(', ')} retained` : 'record only'} · `
        + `Remote: ${remote} · ${references} · ${backup}.`));
    return { container, recovery };
};

const cardFor = (item: TopoPhoto, thumbnail: Blob, objectUrls: string[]) => {
    const card = element('article', 'photo-card');
    card.dataset.localId = item.localId;
    if (thumbnail) {
        const url = URL.createObjectURL(thumbnail);
        objectUrls.push(url);
        const image = element<HTMLImageElement>('img');
        image.src = url;
        image.alt = '';
        card.append(image);
    } else if ((item.remote as TopoRemote).thumbnailUrl!) {
        const image = element<HTMLImageElement>('img');
        image.src = (item.remote as TopoRemote).thumbnailUrl!;
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => {
            image.replaceWith(element('div', 'photo-placeholder', 'Preview unavailable'));
        }, { once: true });
        card.append(image);
    } else {
        card.append(element('div', 'photo-placeholder', 'Local topo draft'));
    }

    const body = element('div', 'photo-card-body');
    body.append(element('h3', '', item.title));
    if (item.caption) body.append(element('p', '', item.caption));
    body.append(element('p', '', `${item.source.width} × ${item.source.height} · `
        + `${formatBytes(item.export?.bytes || item.source.bytes)} · `
        + new Date(item.updatedAt).toLocaleDateString()));
    const chips = element('div', 'status-chips');
    statusLabels(item).forEach(label => {
        const chip = element('span', 'status-chip', label);
        chip.title = label!;
        chips.append(chip);
    });
    body.append(chips);
    const deletedDetails = item.deletedAt ? deletedRecoveryDetails(item) : null;
    if (deletedDetails) body.append(deletedDetails.container);
    const actions = element('div', 'card-actions');
    const appendAction = (action: string, button: HTMLButtonElement) => {
        button.dataset.action = action;
        actions.append(button);
    };
    if (!LOCAL_PHOTO_ID && !item.deletedAt && ['uploaded', 'unreachable'].includes(item.remote.state)) {
        appendAction(RETURN_TOKEN ? 'insert' : 'copy', makeLibraryButton(RETURN_TOKEN ? 'Insert' : 'Copy URL',
            (control: HTMLButtonElement) => insertFromLibrary(item, control), 'The image could not be inserted. Try again.', 'secondary-button'));
    }
    if (!item.deletedAt && item.assets.originalRetained && item.assets.projectRetained) {
        // Editing a published photo forks a new draft; the label says so up front.
        if (canEditReportPhoto(item)) appendAction('edit', makeButton(
            PUBLISHED_STATES.includes(item.remote.state as string) ? 'Edit as new version' : 'Edit',
            event => void editAsNewVersion(item, event.currentTarget)));
        appendAction('export', makeLibraryButton('Export image', () => exportLibraryItem(item),
            'This image could not be exported. Try again.'));
        appendAction('download', makeLibraryButton('Download project', () => downloadProject(item),
            'This project could not be downloaded. Try again.'));
    }
    if (!item.deletedAt && (item.remote as TopoRemote).viewerUrl!) {
        appendAction('open', makeButton('Open on ImgBB',
            () => void ext.tabs.create({ url: (item.remote as TopoRemote).viewerUrl! })));
    }
    appendAction(item.deletedAt ? 'restore' : 'remove', item.deletedAt
        ? makeLibraryButton(deletedDetails?.recovery.editingDataRecoverable
            ? 'Restore with editing data'
            : 'Restore record only', () => restoreLibraryItem(item),
        'The photo could not be restored. Try again.', 'secondary-button')
        : makeLibraryButton('Remove…', () => moveToDeleted(item),
            'The photo could not be moved to Recently Deleted. Try again.', 'danger-button'));
    body.append(actions);
    card.append(body);
    return card;
};

const renderStorageEstimate = async () => {
    if (!navigator.storage?.estimate) return;
    try {
        const estimate = await navigator.storage.estimate();
        ui.storageSummary.textContent = Number.isFinite(estimate.usage)
            ? `${formatBytes(estimate.usage!)} used by this extension profile`
            : '';
    } catch {
        ui.storageSummary.textContent = '';
    }
};

const libraryFocusFallback = () => {
    const target = ui.libraryEmpty.hidden ? ui.libraryList : ui.libraryEmpty;
    target.tabIndex = -1;
    return target;
};

async function drawLibrary() {
    const all: TopoPhoto[] = await store.listPhotos({ includeDeleted: true });
    const filter = ui.filter.value;
    const latest = Library.latestPhotos(all);
    const latestIds = new Set(latest.map(item => item.localId));
    // An unresolved upload is still actionable even if another version exists.
    const visible = [...latest, ...all.filter(item => !item.deletedAt && !latestIds.has(item.localId)
        && ['uploading', 'outcome-unknown'].includes(item.remote.state))];
    const items = filter === 'recently-deleted'
        ? all.filter(item => item.deletedAt)
        : Library.search(filter === 'needs-attention' ? all : visible, ui.search.value, filter);
    const pageCount = Math.max(1, Math.ceil(items.length / LIBRARY_PAGE_SIZE));
    libraryPage = Math.min(libraryPage, pageCount - 1);
    const pageStart = libraryPage * LIBRARY_PAGE_SIZE;
    const pageItems = items.slice(pageStart, pageStart + LIBRARY_PAGE_SIZE) as TopoPhoto[];
    const thumbnails = await store.getThumbnails(pageItems.map(item => item.localId));
    // Prepare one bounded page and its object URLs before replacing the visible
    // grid. A failed read leaves the old page intact; a successful replacement
    // revokes every URL that belonged to it immediately afterward.
    const nextObjectUrls: string[] = [];
    let cards;
    try {
        cards = pageItems.map(item =>
            cardFor(item, thumbnails.get(item.localId), nextObjectUrls));
    } catch (error) {
        nextObjectUrls.forEach(url => URL.revokeObjectURL(url));
        throw error;
    }
    const restoreFocus = listFocusRestorer(ui.libraryList, 'localId', libraryFocusFallback);
    const paginationFocus = ([ui.libraryPrevious, ui.libraryNext] as (Element | null)[]).includes(document.activeElement)
        ? document.activeElement as HTMLButtonElement : null;
    const previousObjectUrls = libraryObjectUrls;
    libraryObjectUrls = nextObjectUrls;
    ui.libraryList.replaceChildren(...cards);
    previousObjectUrls.forEach(url => URL.revokeObjectURL(url));
    ui.libraryEmpty.hidden = items.length > 0;
    ui.libraryPagination.hidden = items.length <= LIBRARY_PAGE_SIZE;
    ui.libraryPrevious.disabled = libraryPage === 0;
    ui.libraryNext.disabled = libraryPage >= pageCount - 1;
    ui.libraryPageStatus.textContent = items.length
        ? `Page ${libraryPage + 1} of ${pageCount} · ${items.length} photos`
        : '';
    restoreFocus();
    if (paginationFocus?.disabled && ([document.body, paginationFocus] as (Element | null)[]).includes(document.activeElement)) {
        const next = [ui.libraryPrevious, ui.libraryNext].find(control => !control.disabled && !control.closest('[hidden]'));
        (next || ui.libraryList.querySelector('button') || libraryFocusFallback()).focus({ preventScroll: true });
    }
    await renderStorageEstimate();
}

// Two overlapping passes each clear the grid and then append into it, so every
// photo lands twice and the newer pass revokes the thumbnail object URLs the
// older one is still loading. Opening with ?mode=library did exactly that:
// setView() starts a pass and initialize() immediately awaits another, and each
// search keystroke starts one more. Coalesce to one running pass plus at most
// one queued behind it, so the last requested state always wins.
function renderLibrary() {
    if (libraryRenderQueued) return libraryRender;
    libraryRenderQueued = true;
    libraryRender = libraryRender.then(() => {
        libraryRenderQueued = false;
        return store ? drawLibrary() : undefined;
    }).catch(() => {
        toast('The photo library could not be listed. Reload and try again.');
    });
    return libraryRender;
}

const resetLibraryPageAndRender = () => {
    libraryPage = 0;
    return renderLibrary();
};

const scheduleLibrarySearch = () => {
    clearTimeout(librarySearchTimer!);
    librarySearchTimer = setTimeout(() => {
        librarySearchTimer = null;
        void resetLibraryPageAndRender();
    }, LIBRARY_SEARCH_DELAY_MS);
};

const scheduleLibraryMaintenance = (delay = LIBRARY_MAINTENANCE_DELAY_MS) => {
    if (libraryMaintenanceTimer || libraryMaintenanceRunning
        || libraryMaintenanceSuspended || teardownStarted) return;
    libraryMaintenanceTimer = setTimeout(async () => {
        libraryMaintenanceTimer = null;
        if (libraryMaintenanceSuspended || teardownStarted) return;
        libraryMaintenanceRunning = true;
        const now = new Date();
        const before = new Date(now.getTime() - RECENTLY_DELETED_MS).toISOString();
        let nextDelay = null;
        try {
            const result = await store.pruneDeletedAssets({
                before,
                now: now.toISOString(),
                limit: LIBRARY_MAINTENANCE_BATCH,
            } as never);
            libraryMaintenanceFailure = null;
            if (result.pruned && ui.filter.value === 'recently-deleted'
                && !ui.libraryView.hidden) void renderLibrary();
            if (result.remaining > 0) nextDelay = 0;
            else if (result.nextDeletedAt) {
                nextDelay = Math.max(0,
                    Date.parse(result.nextDeletedAt) + RECENTLY_DELETED_MS - Date.now());
            }
        } catch (error) {
            if (!libraryMaintenanceFailure) {
                console.warn('Better Peakbagger: photo library maintenance failed', error);
            }
            libraryMaintenanceFailure = {
                at: new Date().toISOString(),
                message: error instanceof Error ? error.message : String(error),
            };
            nextDelay = LIBRARY_MAINTENANCE_RETRY_MS;
        } finally {
            libraryMaintenanceRunning = false;
            if (nextDelay != null) scheduleLibraryMaintenance(nextDelay);
        }
    }, delay);
};

const suspendLibraryMaintenance = () => {
    libraryMaintenanceSuspended = true;
    clearTimeout(libraryMaintenanceTimer!);
    libraryMaintenanceTimer = null;
};

const resumeLibraryMaintenance = () => {
    if (teardownStarted) return;
    libraryMaintenanceSuspended = false;
    if (store) scheduleLibraryMaintenance(0);
};

const setPhotoBackupStatus = createPhotoBackupStatus(ui.backupStatus);

const setPhotoBackupBusy = (value: boolean) => {
    photoBackupBusy = value;
    ui.backupNow.setAttribute('aria-disabled', String(value));
    ui.backupNow.setAttribute('aria-busy', String(value));
};

const refreshPhotoBackupStatus = async () => {
    const response = await send({ type: 'GITHUB_PHOTOS_STATUS' });
    if (!response?.ok) {
        setPhotoBackupStatus('GitHub recovery is unavailable.');
        ui.backupNow.disabled = true;
        return false;
    }
    ui.backupNow.disabled = !response.connected || storeReloadRequired;
    if (!response.connected) {
        setPhotoBackupStatus('Connect a GitHub backup repository in Settings to enable recovery.');
        return false;
    }
    const repository = response.repo?.fullName
        || [response.repo?.owner, response.repo?.name].filter(Boolean).join('/');
    const context = {
        state: response.state, auto: response.auto, repository,
    };
    setPhotoBackupStatus(formatPhotoBackupStatus(context as never), context as never);
    return true;
};

const backupPhotoLibrary = async () => {
    if (photoBackupBusy || ui.backupNow.disabled) return;
    setPhotoBackupBusy(true);
    setPhotoBackupStatus('Backing up photo metadata…');
    try {
        const response = await send({ type: 'GITHUB_PHOTOS_BACKUP' });
        if (response?.ok) {
            const statusCurrent = await refreshPhotoBackupStatus();
            toast(statusCurrent
                ? response.reconciliationPending
                    ? response.warning?.message || 'The GitHub backup is safe, but local backup status is not yet confirmed.'
                    : 'Photo-library metadata backed up to GitHub.'
                : 'The backup finished, but its current GitHub status could not be refreshed.');
            void renderLibrary();
            return;
        }
        setPhotoBackupStatus(response?.error?.code === 'photo-backup-conflict'
            ? `Backup conflict in ${response.error.conflictCount || 1} photo record(s). `
                + 'Restore from Settings and review before backing up again.'
            : response?.error?.message || 'The photo-library backup failed. Try again.');
    } finally { setPhotoBackupBusy(false); }
};

const bindInspector = () => {
    ui.color.addEventListener('change', () => applyStyle({ color: ui.color.value }));
    ui.routeWidth.addEventListener('input', () => {
        if (['route', 'drawing'].includes(inspectorType() as string)) {
            const width = Number(ui.routeWidth.value);
            ui.routeWidthValue.textContent = pixels(width);
            applyStyle({ width }, { coalesce: 'width' });
        }
    });
    ui.routeStroke.addEventListener('change', () => {
        if (['route', 'drawing'].includes(inspectorType() as string)) applyStyle({ stroke: ui.routeStroke.value });
    });
    ui.routeArrow.addEventListener('change', () => {
        if (['route', 'drawing'].includes(inspectorType() as string)) {
            applyStyle({ end: ui.routeArrow.checked ? 'arrow' : 'none' });
        }
    });
    ui.routeSmooth.addEventListener('change', () => {
        if (['route', 'drawing'].includes(inspectorType() as string)) {
            // Clearing the controls hands the curve back to the model, which
            // re-derives it from the points on every clean.
            applyStyle({ smooth: ui.routeSmooth.checked }, { geometry: { controls: [] } });
        }
    });
    ui.opacity.addEventListener('input', () => {
        const opacity = Number(ui.opacity.value) / 100;
        ui.opacityValue.textContent = percent(opacity);
        applyStyle({ opacity }, { coalesce: 'opacity' });
    });
    ui.scale.addEventListener('input', () => {
        const type = inspectorType();
        if (type && !['route', 'drawing'].includes(type)) {
            const scale = Number(ui.scale.value);
            ui.scaleValue.textContent = pixels(Renderer.objectSizePixels(type, project!.image, scale));
            applyStyle({ scale }, { coalesce: 'scale' });
        }
    });
    ui.rotation.addEventListener('input', () => {
        const object = selectedObject();
        const rotation = Number(ui.rotation.value);
        ui.rotationValue.textContent = `${rotation}°`;
        if (object && !['route', 'drawing'].includes(object.type)) {
            updateSelected({ geometry: { ...object.geometry, rotation } }, { coalesce: 'rotation' });
        } else if (inspectorType() && !['route', 'drawing'].includes(inspectorType() as string)) {
            rememberTool(inspectorType() as string, { rotation });
        }
    });
    ui.textWidth.addEventListener('change', () => {
        const object = selectedObject();
        if (object?.type !== 'text') return;
        const width = ui.textWidth.value === '' ? null : Number(ui.textWidth.value);
        if (ui.textWidth.validity.valid) {
            if (width === (object.geometry.width ?? null)) return;
            updateSelected({ geometry: { ...object.geometry, width } });
        } else {
            ui.textWidth.value = object.geometry.width == null ? '' : String(Math.round(object.geometry.width));
        }
    });
    ui.textWidthAuto.addEventListener('click', () => {
        const object = selectedObject();
        if (object?.type === 'text' && object.geometry.width != null) {
            updateSelected({ geometry: { ...object.geometry, width: null } });
        }
    });
    ui.pitch.addEventListener('change', () => {
        const object = selectedObject();
        if (object?.type === 'pitch') updateSelected({ pitch: Number(ui.pitch.value) });
    });
    ui.text.addEventListener('input', () => {
        const object = selectedObject();
        if (object?.type === 'text' && ui.text.value.trim()
            && ui.text.value.trim() !== object.text) {
            updateSelected({ text: ui.text.value }, { coalesce: 'text' });
        }
    });
    ui.text.addEventListener('change', () => {
        if (selectedObject()?.type === 'text' && !ui.text.value.trim()) deleteSelected();
    });
    // A range input fires `change` when the drag ends and a text field when it
    // loses focus, so the next gesture on the same control is its own Undo step
    // rather than being folded into the last one.
    for (const control of [ui.opacity, ui.routeWidth, ui.scale, ui.rotation, ui.text]) {
        control.addEventListener('change', endCoalescing);
    }
    ui.align.addEventListener('change', () => {
        if (inspectorType() === 'text') applyStyle({ align: ui.align.value });
    });
    ui.background.addEventListener('change', () => {
        if (['pitch', 'text'].includes(inspectorType() as string)) {
            applyStyle({ background: ui.background.checked });
        }
    });
};

const bindEvents = () => {
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(applyReportWidthPreview).observe(ui.viewport);
    }
    window.addEventListener('resize', () => {
        syncTextEditor();
        applyViewportSize();
    });
    ui.zoomIn.addEventListener('click', () => zoomPhoto(camera.scale * 1.25));
    ui.zoomOut.addEventListener('click', () => zoomPhoto(camera.scale / 1.25));
    ui.fit.addEventListener('click', fitPhoto);
    ui.zoom.addEventListener('change', () => {
        if (ui.zoom.value === 'fit') fitPhoto();
        else if (ui.zoom.value !== 'custom') zoomPhoto(Number(ui.zoom.value));
    });
    ui.pan.addEventListener('click', () => {
        cancelDrawing();
        if (routeSession) finishRoute(false);
        handMode = !handMode;
        updatePanCursor();
    });
    ui.viewportWidth.addEventListener('change', () => {
        viewportSize.width = cleanViewportDimension(Number(ui.viewportWidth.value), 280, 2400);
        saveViewportSize();
    });
    ui.viewportHeight.addEventListener('change', () => {
        viewportSize.height = cleanViewportDimension(Number(ui.viewportHeight.value), 240, 1400);
        saveViewportSize();
    });
    ui.resetViewport.addEventListener('click', () => {
        viewportSize = { width: null, height: null };
        saveViewportSize();
    });
    ui.viewport.addEventListener('pointerdown', event => {
        if (!project || drawingSession || dragSession || panSession
            || !(event.button === 1 || (event.button === 0 && (handMode || spacePan)))) return;
        event.preventDefault();
        event.stopPropagation();
        camera.fit = false;
        panSession = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            startX: camera.x, startY: camera.y };
        ui.viewport.setPointerCapture?.(event.pointerId);
        updatePanCursor();
    }, true);
    ui.viewport.addEventListener('pointermove', event => {
        if (!panSession || event.pointerId !== panSession.pointerId) return;
        camera.x = panSession.startX + event.clientX - panSession.x;
        camera.y = panSession.startY + event.clientY - panSession.y;
        applyReportWidthPreview();
    });
    ui.viewport.addEventListener('pointerup', endPan);
    ui.viewport.addEventListener('pointercancel', endPan);
    ui.viewport.addEventListener('lostpointercapture', endPan);
    ui.viewport.addEventListener('wheel', event => {
        if (!project) return;
        event.preventDefault();
        if (drawingSession || dragSession || panSession) return;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? ui.viewport.clientHeight : 1;
        if (event.ctrlKey || event.metaKey || event.altKey) {
            const rect = ui.viewport.getBoundingClientRect();
            zoomPhoto(camera.scale * Math.exp(-Math.max(-200, Math.min(200, event.deltaY * unit)) * 0.01),
                { x: event.clientX - rect.left, y: event.clientY - rect.top });
        } else {
            camera.fit = false;
            camera.x -= event.deltaX * unit;
            camera.y -= event.deltaY * unit;
            applyReportWidthPreview();
        }
    }, { passive: false });
    window.addEventListener('blur', () => { spacePan = false; endPan(); cancelDrawing(); });
    ui.showEditor.addEventListener('click', () => setView('editor'));
    ui.showLibrary.addEventListener('click', () => setView('library'));
    ui.imgbbForm.addEventListener('submit', event => { event.preventDefault(); submitKeyDialog(); });
    ui.imgbbClose.addEventListener('click', closeKeyDialog);
    ui.imgbbCancel.addEventListener('click', closeKeyDialog);
    ui.imgbbDialog.addEventListener('close', () => {
        ui.key.value = '';
        dialogError('');
        if (dialogReturnFocus?.isConnected && !dialogReturnFocus.hidden) dialogReturnFocus.focus({ preventScroll: true });
        dialogReturnFocus = null;
    });
    ui.forgetKey.addEventListener('click', () => void removeCredential());
    ui.upload.addEventListener('click', onFinishSlot);
    ui.copyImage.addEventListener('click', copyImage);
    ui.exportImage.addEventListener('click', () => void exportImage());
    ui.outputSummary.addEventListener('click', () => {
        ui.uploadFormat.scrollIntoView({ block: 'nearest' });
        ui.uploadFormat.focus({ preventScroll: true });
    });
    ui.newPhoto.addEventListener('click', () => {
        if (unavailable(ui.newPhoto) || insertionConfirmed) return;
        // Opened inside the click so the picker keeps its user activation;
        // the current topo is settled and saved once a file is chosen.
        ui.file.value = '';
        ui.file.click();
    });
    ui.resumeDraftAll.addEventListener('click', () => {
        ui.filter.value = 'drafts';
        setView('library');
    });
    // Settings owns the same device-local key, so a claim made when this tab
    // loaded can be stale by the time the user comes back to it. Never refresh
    // while they are typing in the form the answer would hide.
    window.addEventListener('focus', () => {
        const wasOpen = ui.imgbbDialog.open;
        void refreshCredential().then(() => {
            if (wasOpen && ui.imgbbDialog.open && configuredKey) {
                closeKeyDialog();
                toast('ImgBB is now set up on this device. Choose Upload when you’re ready.');
            }
        });
    });
    ui.file.addEventListener('change', () => void chooseFile(ui.file.files?.[0]));
    ui.editorEmpty.addEventListener('dragenter', onPhotoDragEnter);
    ui.editorEmpty.addEventListener('dragover', onPhotoDragOver);
    ui.editorEmpty.addEventListener('dragleave', onPhotoDragLeave);
    ui.editorEmpty.addEventListener('drop', onPhotoDrop);
    document.addEventListener('paste', onPhotoPaste);
    document.addEventListener('copy', onAnnotationCopy);
    document.addEventListener('paste', onAnnotationPaste);
    ui.title.addEventListener('input', schedulePersist);
    ui.caption.addEventListener('input', schedulePersist);
    ui.undo.addEventListener('click', undo);
    ui.redo.addEventListener('click', redo);
    document.querySelectorAll<HTMLElement>('[data-tool]').forEach(button => {
        button.addEventListener('click', () => setTool(button.dataset.tool));
    });
    ui.addAtCenter.addEventListener('click', addAtCenter);
    ui.annotationList.addEventListener('click', event => {
        const button = (event.target as Element).closest?.<HTMLElement>('[data-object-id]');
        if (button) selectAnnotation(button.dataset.objectId!);
    });
    ui.routePointList.addEventListener('click', event => {
        const button = (event.target as Element).closest?.<HTMLElement>('[data-vertex]');
        if (button) selectAnnotation(button.dataset.objectId!, Number(button.dataset.vertex));
    });
    ui.insertRoutePoint.addEventListener('click', insertRoutePoint);
    ui.removeRoutePoint.addEventListener('click', removeRoutePoint);
    ui.finishRoute.addEventListener('click', () => finishRoute(false));
    ui.overlay.addEventListener('pointerdown', onPointerDown);
    ui.overlay.addEventListener('pointermove', moveDrag);
    ui.overlay.addEventListener('pointerup', event => {
        if (dragSession?.resize && event.pointerId !== dragSession.pointerId) return;
        finishDrawing(event); endDrag();
    });
    ui.overlay.addEventListener('pointercancel', () => { cancelDrawing(); if (!cancelTextResize()) endDrag(); });
    ui.overlay.addEventListener('lostpointercapture', cancelTextResize);
    ui.overlay.addEventListener('lostpointercapture', cancelDrawing);
    ui.overlay.addEventListener('pointerleave', () => {
        if (!routeSession) return;
        routeSession.cursor = null;
        renderRoutePreview();
    });
    // A browser that does deliver `dblclick` here is welcome to; `finishRoute`
    // ignores the second call once the press pair has already ended the route.
    ui.overlay.addEventListener('dblclick', () => {
        if (activeTool === 'route') finishRoute(false);
    });
    // Right-click ends the line the way every other polyline editor does, and
    // only while one is being drawn — the page's own menu belongs to the user
    // the rest of the time. The press itself places nothing: `onPointerDown`
    // answers to the primary button alone.
    ui.overlay.addEventListener('contextmenu', event => {
        if (!routeSession) return;
        event.preventDefault();
        finishRoute(false);
    });
    ui.sendBack.addEventListener('click', () => {
        if (selectedId) setProject(Project.reorderObject(project!, selectedId, 'back'));
    });
    ui.bringFront.addEventListener('click', () => {
        if (selectedId) setProject(Project.reorderObject(project!, selectedId, 'front'));
    });
    ui.duplicate.addEventListener('click', duplicateSelected);
    ui.deleteObject.addEventListener('click', deleteSelected);
    ui.clear.addEventListener('click', () => {
        if (editorMutationLocked()) return;
        const count = project?.objects.length || 0;
        if (!count || !confirm(`Remove all ${count} annotation${count === 1 ? '' : 's'}? You can Undo this.`)) {
            return;
        }
        selectedId = null;
        selectedVertex = null;
        setProject(Project.removeObjects(project, project!.objects.map(object => object.id)));
        toast(`${count} annotation${count === 1 ? '' : 's'} removed.`, {
            action: 'Undo',
            onAction: undo,
        });
    });
    ui.saveConflictedDraft.addEventListener('click', () => {
        if (editorMutationLocked() || replacingOtherTab) return;
        replacingOtherTab = true;
        updateEditorControls();
        void persistDraft({ replaceOtherTab: true }).finally(() => {
            replacingOtherTab = false;
            updateEditorControls();
        });
    });
    ui.uploadFormat.addEventListener('change', () => {
        uploadFormat = ui.uploadFormat.value;
        applyUploadSettings();
    });
    ui.jpegQuality.addEventListener('input', () => {
        jpegQuality = Number(ui.jpegQuality.value) / 100;
        applyUploadSettings({ persist: false });
    });
    ui.jpegQuality.addEventListener('change', () => {
        jpegQuality = Number(ui.jpegQuality.value) / 100;
        applyUploadSettings();
    });
    ui.search.addEventListener('input', scheduleLibrarySearch);
    ui.filter.addEventListener('change', () => {
        clearTimeout(librarySearchTimer!);
        librarySearchTimer = null;
        void resetLibraryPageAndRender();
    });
    ui.libraryPrevious.addEventListener('click', () => {
        if (libraryPage <= 0) return;
        libraryPage -= 1;
        void renderLibrary();
    });
    ui.libraryNext.addEventListener('click', () => {
        libraryPage += 1;
        void renderLibrary();
    });
    ui.importProject.addEventListener('change', () => void importProject(ui.importProject.files?.[0]));
    ui.backupNow.addEventListener('click', () => void backupPhotoLibrary());
    ext.storage.onChanged?.addListener((changes, area) => {
        if (area !== 'local' || !changes.bpbPhotoLibraryBackupState || photoBackupBusy) return;
        void refreshPhotoBackupStatus().then(() => {
            if (!ui.libraryView.hidden) void renderLibrary();
        });
    });
    for (const select of ui.reportWidthSelects) {
        select.addEventListener('change', event => void chooseReportImageWidth(event));
    }
    ui.toastAction.addEventListener('click', () => {
        if (undoDeleted) undoDeleted = null;
    });
    bindInspector();

    document.addEventListener('keydown', event => {
        const { editing, editorScoped } = editorEventContext(event);
        if (busy || !editorScoped) return;
        if (event.key === 'Escape' && cancelTextResize()) { event.preventDefault(); return; }
        if (dragSession?.resize || editing) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
            const available = event.shiftKey
                ? !drawingSession && (routeSession ? routeSession.removedPoints.length : future.length)
                : drawingSession || routeSession?.points.length || history.length;
            if (!available || editorMutationLocked() || !project) return;
            event.preventDefault();
            if (event.shiftKey) redo();
            else undo();
            return;
        }
        // Everything below is a bare key. Claiming Cmd/Ctrl/Alt combinations too
        // meant reaching for a browser command silently armed a topo tool behind
        // the dialog — Cmd+P armed Piton, Ctrl+A armed Anchor — and the user's
        // next click on the photo dropped a mark they never asked for. Shift is
        // not excluded: it is this page's own "nudge further" modifier.
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (project && ['+', '=', '-', '0', ' ', 'h', 'H'].includes(event.key)) {
            if (event.key === ' ') {
                if ((event.target as Element).closest?.('button, summary, a')) return;
                event.preventDefault(); spacePan = true; updatePanCursor();
            } else if (event.key.toLowerCase() === 'h') {
                if (!event.repeat) ui.pan.click();
            }
            else if (event.key === '0') fitPhoto();
            else zoomPhoto(camera.scale * (event.key === '-' ? 0.8 : 1.25));
            return;
        }
        if (event.key === 'Escape') {
            if (handMode || panSession) { handMode = false; endPan(); return; }
            // One predictable ladder out of whatever the user is in the middle
            // of: abandon the route, then disarm the tool, then deselect.
            if (drawingSession) cancelDrawing();
            else if (routeSession) finishRoute(true);
            else if (activeTool !== 'select') setTool('select');
            else {
                selectedId = null;
                selectedVertex = null;
                renderProject();
            }
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
            if (!selectedId || editorMutationLocked()) return;
            event.preventDefault();
            if (selectedObject()?.type === 'route' && selectedVertex != null) removeRoutePoint();
            else deleteSelected();
        } else if (project && toolShortcuts.has(event.key.toLowerCase())) {
            setTool(toolShortcuts.get(event.key.toLowerCase()));
        } else if (event.key === 'Enter' && routeSession) finishRoute(false);
        else if (event.key.startsWith('Arrow')) {
            if (!selectedObject() || editorMutationLocked()) return;
            const step = event.shiftKey ? 10 : 1;
            const directions = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
            };
            event.preventDefault();
            nudgeSelected(...(directions[event.key as keyof typeof directions] as [number, number]));
        }
    });
    // Releasing the key ends the nudge, so a held arrow is one Undo and the
    // next press is another.
    document.addEventListener('keyup', event => {
        if (event.key === ' ') { spacePan = false; updatePanCursor(); }
        if (event.key.startsWith('Arrow')) endCoalescing();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            suspendLibraryMaintenance();
            void flushDraftPersistence();
        } else {
            resumeLibraryMaintenance();
        }
    });
    window.addEventListener('pagehide', () => {
        suspendLibraryMaintenance();
        void flushDraftPersistence();
        // A remembered key that ImgBB may already have seen must not vanish
        // with the tab before its upload settles.
        if (pendingKey?.remember && pendingKeyReachedProvider && !configuredKey) {
            void send({ type: 'PHOTO_IMGBB_SAVE_KEY', key: pendingKey.value });
        }
    });
    window.addEventListener('pageshow', () => {
        resumeLibraryMaintenance();
    });
    window.addEventListener('beforeunload', () => {
        if (teardownStarted) return;
        teardownStarted = true;
        suspendLibraryMaintenance();
        const pendingDraftWrite = flushDraftPersistence();
        unsubscribeSettings();
        clearTimeout(librarySearchTimer!);
        closeSource();
        libraryObjectUrls.forEach(url => URL.revokeObjectURL(url));
        // Closing IndexedDB here used to abort the only chance to persist an
        // edit made inside the autosave debounce. Keep the connection alive
        // until the serialized queue settles; the lifecycle event itself
        // remains synchronous and never delays navigation.
        void pendingDraftWrite.finally(() => store?.close());
    });
};

// The rail's own <kbd> hints are the single source for the shortcuts, so a key
// shown on a button is always the key that arms it.
const toolShortcuts = new Map();

const paintToolRail = () => {
    for (const button of document.querySelectorAll<HTMLElement>('[data-tool]')) {
        const key = button.querySelector('kbd')?.textContent.trim().toLowerCase();
        if (key?.length === 1) toolShortcuts.set(key, button.dataset.tool);
        const slot = button.querySelector('[data-symbol]');
        if (!slot) continue;
        // Painted from the same geometry the export uses: the symbol a climber
        // is shown on the button cannot drift from the one on the photo.
        const parsed = new DOMParser().parseFromString(
            Renderer.markerSymbolSvg((slot as HTMLElement).dataset.symbol),
            'image/svg+xml',
        );
        slot.replaceChildren(document.importNode(parsed.documentElement, true));
    }
};

// Order is fixed for the page's lifetime, so tab order always matches what is
// on screen: standalone sessions end on Export, report sessions on Upload.
const trackHeaderHeight = () => {
    const header = document.querySelector<HTMLElement>('.app-header');
    if (!header || typeof ResizeObserver !== 'function') return;
    // The sticky top bar parks just under the sticky page header.
    new ResizeObserver(() => {
        document.documentElement.style.setProperty('--photo-header-height', `${header.offsetHeight}px`);
    }).observe(header);
};

const arrangeFinishActions = () => {
    if (!Output.clipboardImageSupported()) ui.copyImage.hidden = true;
    const state = Output.finishState({ context: FINISH_CONTEXT, keyMode: 'none', remoteState: null });
    const gap = ui.finishActions.querySelector('.finish-gap')!;
    if (!state.uploadFirst) ui.finishActions.append(gap, ui.upload, ui.finishStatus);
    ui.finishActions.classList.toggle('upload-first', state.uploadFirst);
    renderFinish();
};

const relativeAge = (iso: string) => {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!Number.isFinite(minutes)) return '';
    const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (Math.abs(minutes) < 60) return format.format(-Math.max(0, minutes), 'minute');
    if (Math.abs(minutes) < 60 * 48) return format.format(-Math.round(minutes / 60), 'hour');
    return format.format(-Math.round(minutes / (60 * 24)), 'day');
};

// The empty state appears once, after the drafts read settles or its short
// bound passes, so the Continue line never pushes Choose photo while the user
// is reaching for it. A result that arrives later is dropped.
const revealEmptyState = (draft: TopoPhoto | null = null) => {
    if (emptyStateRevealed) return;
    emptyStateRevealed = true;
    if (draft) {
        ui.resumeDraftOpen.textContent = `Continue ${draft.title || 'untitled topo'}`;
        ui.resumeDraftAge.textContent = `· edited ${relativeAge(draft.updatedAt)} ·`;
        ui.resumeDraftOpen.onclick = event => void editAsNewVersion(draft, event.currentTarget as HTMLButtonElement);
        ui.resumeDraft.hidden = false;
    }
    if (!project) ui.editorEmpty.hidden = false;
};

const latestResumableDraft = async () => {
    const photos: TopoPhoto[] = await store.listPhotos();
    return Library.latestPhotos(photos)
        .filter(item => !item.deletedAt && item.remote.state === 'draft'
            && item.assets.originalRetained && item.assets.projectRetained)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
};

const RESUME_READ_BOUND_MS = 400;

const initialize = async () => {
    const plainSession = !LOCAL_PHOTO_ID && !SOURCE_IMAGE_URL;
    if (plainSession) setTimeout(() => revealEmptyState(), RESUME_READ_BOUND_MS);
    for (let number = 1; number <= 50; number += 1) {
        const option = element<HTMLOptionElement>('option', '', `P${number}`);
        option.value = String(number);
        ui.pitch.append(option);
    }
    await loadToolPreferences();
    paintToolRail();
    paintReportWidthControls();
    syncUploadControls();
    const settings = await Settings.get();
    applyPhotoSettings(settings);
    unsubscribeSettings = Settings.subscribe(applyPhotoSettings);
    bindEvents();
    store = await Store.createPhotoStore({
        onVersionChange: () => {
            storeReloadRequired = true;
            suspendLibraryMaintenance();
            endCoalescing();
            updateEditorControls();
            for (const control of [
                ui.search,
                ui.filter,
                ui.libraryPrevious,
                ui.libraryNext,
                ui.backupNow,
                ...ui.libraryList.querySelectorAll<HTMLButtonElement>('button'),
            ]) control.disabled = true;
            setEditorStatus('Photo library updated in another tab. Reload to continue.');
            toast('The photo library was updated in another tab. Reload this page to continue.', {
                duration: 0,
            });
        },
    });
    if (plainSession) void latestResumableDraft().then(revealEmptyState, () => revealEmptyState());
    await recoverOperations();
    if (await store.pruneSupersededVersions()) notifyBackupChanged();
    await refreshCredential();
    await refreshPhotoBackupStatus();
    arrangeFinishActions();
    trackHeaderHeight();
    setView(START_MODE === 'library' ? 'library' : 'editor');
    await renderLibrary();
    if (LOCAL_PHOTO_ID) {
        const bundle = await store.getBundle(LOCAL_PHOTO_ID);
        if (!bundle?.photo) throw new Error('The local photo is unavailable.');
        await editAsNewVersion(bundle.photo);
        if (project && SOURCE_IMAGE_CAPTION !== null && SOURCE_IMAGE_CAPTION !== (photo!.caption || '')) { ui.caption.value = SOURCE_IMAGE_CAPTION; schedulePersist(); }
        setEditorStatus('Edits stay on this device. Save and return to update the TR.');
    } else if (SOURCE_IMAGE_URL && RETURN_TOKEN) {
        try {
            const photos: TopoPhoto[] = await store.listPhotos({ includeDeleted: true });
            const existing = photos.find(item => !item.deletedAt
                && [(item.remote as TopoRemote)?.url, (item.remote as TopoRemote)?.displayUrl, (item.remote as TopoRemote)?.mediumUrl].includes(SOURCE_IMAGE_URL));
            const latest = existing && Library.latestPhotos(photos)
                .find(item => item.source.sha256 === existing.source.sha256);
            const bundle = latest ? await store.getBundle(latest.localId) : null;
            if (bundle?.original && bundle?.project) await editAsNewVersion(existing!);
            else await chooseFile(await readPhotoSourceUrl(SOURCE_IMAGE_URL, { maxBytes: MAX_ENCODED_SOURCE_BYTES } as never));
            if (project && SOURCE_IMAGE_CAPTION !== null && SOURCE_IMAGE_CAPTION !== (photo!.caption || '')) { ui.caption.value = SOURCE_IMAGE_CAPTION; schedulePersist(); }
        } catch {
            toast('The image could not be opened from its host or local library. Download it and choose the file to continue editing.', {
                action: 'Choose image', onAction: () => ui.file.click(), duration: 0,
            });
        }
    }
    if (!plainSession) revealEmptyState();
    scheduleLibraryMaintenance();
};

void initialize().catch(() => {
    revealEmptyState();
    toast('The local photo library could not be opened. Reload and try again.', { duration: 0 });
});
