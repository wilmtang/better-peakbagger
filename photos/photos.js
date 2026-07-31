// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { photoProject as Project } from '../src/photos/photo-project.js';
import { photoRenderer as Renderer } from '../src/photos/photo-renderer.js';
import { photoLibrary as Library } from '../src/photos/photo-library.js';
import { photoStore as Store } from '../src/photos/photo-store.js';
import { photoArchive as Archive } from '../src/photos/photo-archive.js';
import { imgbbClient as ImgbbClient } from '../src/photos/imgbb-client.js';

const ext = globalThis.browser || globalThis.chrome;
const SVG_NS = 'http://www.w3.org/2000/svg';
const RETURN_TOKEN = new URL(location.href).searchParams.get('returnToken') || '';
const START_MODE = new URL(location.href).searchParams.get('mode') === 'library' ? 'library' : 'edit';
const IMGBB_PERMISSION = { origins: ['https://api.imgbb.com/*'] };
const HISTORY_LIMIT = 100;
// Once ImgBB holds a URL the local copy is no longer the editable source of
// truth; changing it in place would silently diverge from the published image.
const PUBLISHED_STATES = ['uploaded', 'unreachable'];
const AUTOSAVE_DELAY_MS = 500;
const RECENTLY_DELETED_MS = 30 * 24 * 60 * 60 * 1000;

const byId = id => document.getElementById(id);
const ui = {
    credentialCard: byId('credential-card'),
    credentialSummary: byId('credential-summary'),
    credentialForm: byId('credential-form'),
    key: byId('imgbb-key'),
    rememberKey: byId('remember-key'),
    saveKey: byId('save-key'),
    removeKey: byId('remove-key'),
    showEditor: byId('show-editor'),
    showLibrary: byId('show-library'),
    editorView: byId('editor-view'),
    libraryView: byId('library-view'),
    editorEmpty: byId('editor-empty'),
    editorWorkspace: byId('editor-workspace'),
    file: byId('photo-file'),
    title: byId('photo-title'),
    alt: byId('photo-alt'),
    undo: byId('undo'),
    redo: byId('redo'),
    viewport: byId('photo-viewport'),
    stage: byId('photo-stage'),
    sourceImage: byId('source-image'),
    overlay: byId('photo-overlay'),
    finishRoute: byId('finish-route'),
    editorStatus: byId('editor-status'),
    inspector: byId('inspector'),
    inspectorHeading: byId('inspector-heading'),
    objectActions: byId('object-actions'),
    color: byId('object-color'),
    opacity: byId('object-opacity'),
    opacityValue: byId('object-opacity-value'),
    routeWidth: byId('route-width'),
    routeWidthValue: byId('route-width-value'),
    routeStroke: byId('route-stroke'),
    routeArrow: byId('route-arrow'),
    routeSmooth: byId('route-smooth'),
    scale: byId('object-scale'),
    scaleValue: byId('object-scale-value'),
    rotation: byId('object-rotation'),
    rotationValue: byId('object-rotation-value'),
    pitch: byId('pitch-number'),
    text: byId('object-text'),
    align: byId('text-align'),
    background: byId('label-background'),
    sendBack: byId('send-back'),
    bringFront: byId('bring-front'),
    duplicate: byId('duplicate-object'),
    deleteObject: byId('delete-object'),
    clear: byId('clear-annotations'),
    upload: byId('upload-insert'),
    exportSummary: byId('export-summary'),
    saveStatus: byId('save-status'),
    search: byId('library-search'),
    filter: byId('library-filter'),
    importProject: byId('import-project'),
    libraryList: byId('library-list'),
    libraryEmpty: byId('library-empty'),
    storageSummary: byId('storage-summary'),
    backupStatus: byId('photo-backup-status'),
    backupNow: byId('backup-library'),
    toast: byId('toast'),
    toastMessage: byId('toast-message'),
    toastAction: byId('toast-action'),
};

const send = async message => {
    try { return await ext.runtime.sendMessage(message); }
    catch { return null; }
};

const element = (tag, className = '', text = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
};

let store;
let project = null;
let photo = null;
let originalBlob = null;
let thumbnailBlob = null;
let sourceBitmap = null;
let sourceUrl = null;
let selectedId = null;
let activeTool = 'select';
let routeSession = null;
let dragSession = null;
let history = [];
let future = [];
let autosaveTimer = null;
let sessionKey = '';
let configuredKey = false;
let permissionGranted = false;
let busy = false;
let toastTimer = null;
let undoDeleted = null;
let libraryObjectUrls = [];
let libraryRender = Promise.resolve();
let libraryRenderQueued = false;
let photoBackupBusy = false;
// A new mark inherits the last style the user chose, the way every drawing tool
// behaves: dial the opacity back once and the rest of the topo matches instead
// of needing the same three adjustments on every symbol.
let styleDefaults = {
    color: Project.DEFAULT_COLOR,
    opacity: 1,
    scale: 1,
    width: 12,
    stroke: 'solid',
    end: 'none',
    smooth: false,
};

const setEditorStatus = message => { ui.editorStatus.textContent = message; };
const setSaveStatus = message => { ui.saveStatus.textContent = message; };
const notifyBackupChanged = () => { void send({ type: 'GITHUB_PHOTOS_CHANGED' }); };

const toast = (message, { action = '', onAction = null, duration = 5000 } = {}) => {
    clearTimeout(toastTimer);
    ui.toastMessage.textContent = message;
    ui.toastAction.hidden = !action;
    ui.toastAction.textContent = action;
    ui.toastAction.onclick = onAction;
    ui.toast.hidden = false;
    if (duration) toastTimer = setTimeout(() => { ui.toast.hidden = true; }, duration);
};

const setView = view => {
    const editor = view === 'editor';
    ui.editorView.hidden = !editor;
    ui.libraryView.hidden = editor;
    ui.showEditor.setAttribute('aria-current', editor ? 'page' : 'false');
    ui.showLibrary.setAttribute('aria-current', editor ? 'false' : 'page');
    if (!editor) void renderLibrary();
};

const setBusy = (value, message = '') => {
    busy = value;
    ui.upload.disabled = value;
    ui.file.disabled = value;
    ui.importProject.disabled = value;
    ui.saveKey.disabled = value;
    if (message) setEditorStatus(message);
};

const formatBytes = bytes => {
    if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const updateCredentialUi = () => {
    const available = configuredKey || !!sessionKey;
    // Device-saved credentials belong to Settings once configured. Keep this
    // setup card only for a missing key or the session-only key that Settings
    // cannot see or remove.
    ui.credentialCard.hidden = configuredKey;
    ui.credentialCard.classList.toggle('configured', available && permissionGranted);
    ui.credentialForm.hidden = available;
    ui.removeKey.hidden = !sessionKey;
    ui.credentialSummary.textContent = !available
        ? 'Uploads go directly from this browser using your API key.'
        : permissionGranted
            ? configuredKey
                ? 'ImgBB is configured on this device.'
                : 'ImgBB is available until this tab closes.'
            : 'ImgBB is configured, but upload permission is not granted.';
};

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

// permissions.request() rejects outright without a fresh user gesture, and the
// local save that runs first can spend it — a confirm() the user leaves open
// spends it every time. An unhandled rejection here escaped before the caller's
// try block, so the click produced no message at all. Fail visibly instead: the
// callers ask for another click, which restores the gesture.
const requestPermission = async () => {
    try {
        permissionGranted = await ext.permissions.contains(IMGBB_PERMISSION)
            || await ext.permissions.request(IMGBB_PERMISSION);
    } catch {
        permissionGranted = false;
    }
    updateCredentialUi();
    return permissionGranted;
};

const saveCredential = async () => {
    const key = ImgbbClient.cleanKey(ui.key.value);
    if (!key) {
        toast('Enter a valid ImgBB API key.');
        ui.key.focus();
        return;
    }
    if (!await requestPermission()) {
        toast('Allow Better Peakbagger to reach api.imgbb.com, then choose Continue again.');
        return;
    }
    if (ui.rememberKey.checked) {
        const response = await send({ type: 'PHOTO_IMGBB_SAVE_KEY', key });
        if (!response?.ok) {
            toast(response?.error?.message || 'The ImgBB key could not be saved.');
            return;
        }
        configuredKey = true;
        sessionKey = '';
    } else {
        sessionKey = key;
        configuredKey = false;
    }
    ui.key.value = '';
    updateCredentialUi();
    toast(configuredKey ? 'ImgBB key saved on this device.' : 'ImgBB key available for this tab.');
};

const removeCredential = async () => {
    sessionKey = '';
    updateCredentialUi();
    toast('The key was forgotten for this tab. Existing photos were not changed.');
};

const leaseCredential = async () => {
    if (sessionKey) return sessionKey;
    const response = await send({ type: 'PHOTO_IMGBB_LEASE_KEY' });
    return response?.ok ? response.key : null;
};

const closeSource = () => {
    if (sourceBitmap?.close) sourceBitmap.close();
    sourceBitmap = null;
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
};

const decodeBlob = async blob => {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch { return createImageBitmap(blob); }
};

const canvasBlob = (canvas, mime, quality) => new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image encoding failed.')), mime, quality);
});

const makeThumbnail = async bitmap => {
    const maximum = 480;
    const ratio = Math.min(1, maximum / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvasBlob(canvas, 'image/jpeg', 0.82);
};

const defaultTitle = name => String(name || 'Photo')
    .replace(/\.[A-Za-z0-9]{1,10}$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Library.TITLE_LIMIT) || 'Photo';

const setSourceDisplay = blob => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = URL.createObjectURL(blob);
    ui.sourceImage.src = sourceUrl;
    ui.sourceImage.alt = '';
    ui.stage.style.aspectRatio = `${project.image.width} / ${project.image.height}`;
    ui.overlay.setAttribute('viewBox', `0 0 ${project.image.width} ${project.image.height}`);
    ui.overlay.setAttribute('width', String(project.image.width));
    ui.overlay.setAttribute('height', String(project.image.height));
};

const cleanDraftFromFields = now => {
    if (!project || !originalBlob || !thumbnailBlob) return null;
    const fields = {
        title: ui.title.value,
        alt: ui.alt.value,
    };
    if (!photo) {
        return Library.createDraft({
            localId: project.localId,
            ...fields,
            source: {
                fileName: originalBlob.name || 'photo',
                mime: originalBlob.type,
                bytes: originalBlob.size,
                width: project.image.width,
                height: project.image.height,
                sha256: project.image.sourceSha256,
            },
            now,
        });
    }
    return Library.cleanPhoto({
        ...photo,
        ...fields,
        updatedAt: now,
    });
};

const persistDraft = async ({ required = false } = {}) => {
    if (!project || !originalBlob || !thumbnailBlob
        || PUBLISHED_STATES.includes(photo?.remote.state)) return false;
    clearTimeout(autosaveTimer);
    const now = new Date().toISOString();
    const nextPhoto = cleanDraftFromFields(now);
    if (!nextPhoto) {
        setSaveStatus('Add a title to save');
        if (required) toast('Add a title before uploading.');
        return false;
    }
    const nextProject = Project.cleanProject({ ...project, updatedAt: now });
    setSaveStatus('Saving locally…');
    try {
        await store.putDraft({
            photo: nextPhoto,
            project: nextProject,
            original: originalBlob,
            thumbnail: thumbnailBlob,
        });
        photo = nextPhoto;
        project = nextProject;
        setSaveStatus('Saved on this device');
        notifyBackupChanged();
        return true;
    } catch {
        setSaveStatus('Could not save locally');
        if (required && confirm(
                'Better Peakbagger could not retain an editable local copy. '
                + 'Continue with upload without the promise of future non-destructive editing?',
        )) {
            const minimal = Library.updateAssets(nextPhoto, {
                originalRetained: false,
                projectRetained: false,
                thumbnailRetained: false,
            }, now);
            try {
                await store.putPhoto(minimal);
                photo = minimal;
                project = nextProject;
                setSaveStatus('URL record only · editable copy not retained');
                notifyBackupChanged();
                return true;
            } catch {
                toast('The photo catalog is unavailable, so upload cannot safely continue.');
            }
        }
        return false;
    }
};

const schedulePersist = () => {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void persistDraft(), AUTOSAVE_DELAY_MS);
};

const updateHistoryButtons = () => {
    ui.undo.disabled = history.length === 0 || busy;
    ui.redo.disabled = future.length === 0 || busy;
};

const selectedObject = () => project?.objects.find(object => object.id === selectedId) || null;

const percent = opacity => `${Math.round(opacity * 100)}%`;
const pixels = value => `${Math.round(value)} px`;

// The style controls describe the armed tool, not only a placed mark. Arming a
// tool shows the style its next mark will take, so a colour or a lower opacity
// can be chosen before the first click instead of being corrected after it.
// Select has nothing to preset, so it still shows the panel only for a
// selection. `type` is the object type either way: every placement tool is
// named for the type it places.
const inspectorType = () => selectedObject()?.type
    || (activeTool === 'select' ? null : activeTool);

const renderInspector = () => {
    const object = selectedObject();
    const type = inspectorType();
    ui.inspector.hidden = !type;
    if (!type) return;
    const route = type === 'route';
    const label = type === 'pitch' || type === 'text';
    const text = type === 'text';
    const pitch = type === 'pitch';
    ui.inspectorHeading.textContent = object ? 'Selection' : `${toolName(type)} style`;
    document.querySelectorAll('.route-only').forEach(node => { node.hidden = !route; });
    document.querySelectorAll('.scale-only').forEach(node => { node.hidden = route; });
    // Rotation, the pitch number, the text and its alignment, the contrast
    // background, and the layer and delete actions all describe one placed
    // mark. They are not carried to the next one, so before a mark exists there
    // is nothing for them to show or act on.
    document.querySelectorAll('.point-only').forEach(node => { node.hidden = route || !object; });
    document.querySelectorAll('.pitch-only').forEach(node => { node.hidden = !pitch || !object; });
    document.querySelectorAll('.text-only').forEach(node => { node.hidden = !text || !object; });
    document.querySelectorAll('.label-only').forEach(node => { node.hidden = !label || !object; });
    ui.objectActions.hidden = !object;
    const style = object ? object.style : styleDefaults;
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
        ui.scaleValue.textContent = pixels(Renderer.objectSizePixels(type, project.image, style.scale));
    }
    if (!object) return;
    if (!route) {
        ui.rotation.value = String(Math.round(object.geometry.rotation));
        ui.rotationValue.textContent = `${Math.round(object.geometry.rotation)}°`;
    }
    if (pitch) ui.pitch.value = String(object.pitch);
    if (text) {
        ui.text.value = object.text;
        ui.align.value = object.style.align;
    }
    if (label) ui.background.checked = object.style.background;
};

// The first click of a route cannot create an object yet — the schema needs two
// points — so nothing appeared on the photo until the second click landed. Draw
// the pending point, and rubber-band the segment the next click would commit.
const renderRoutePreview = () => {
    ui.overlay.querySelector('.route-preview')?.remove();
    if (!routeSession || !project) return;
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

const renderProject = () => {
    if (!project) return;
    const parsed = new DOMParser().parseFromString(Renderer.renderOverlaySvg(project), 'image/svg+xml');
    const root = parsed.documentElement;
    ui.overlay.replaceChildren(...Array.from(root.childNodes, child => document.importNode(child, true)));
    for (const node of ui.overlay.querySelectorAll('[data-bpb-object]')) {
        if (node.getAttribute('data-bpb-object') === selectedId) node.classList.add('selected');
    }
    const selected = selectedObject();
    // Vertex handles belong to Select. Left on screen while a placement tool is
    // armed they swallow the click that should have placed a symbol, and the
    // symbols a user most wants sit exactly on the route they just drew.
    if (activeTool === 'select' && selected?.type === 'route') {
        const radius = Math.min(project.image.width, project.image.height) * 0.012;
        selected.geometry.points.forEach((point, index) => {
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
    renderRoutePreview();
    ui.exportSummary.textContent = `${project.objects.length} annotation${project.objects.length === 1 ? '' : 's'}`
        + ` · ${project.image.width} × ${project.image.height}`;
    renderInspector();
    updateHistoryButtons();
};

// A slider drag, a run of typing, and a held arrow key are each one thing the
// user did, so each is one Undo. They emit a continuous stream of edits, and
// giving every intermediate value its own history entry made Undo step back a
// tick at a time — worse, one drag of Route width (1–100) pushed 100 entries
// and evicted every real edit behind it from a 100-deep history. A run is
// identified by its control and mark; it ends when the gesture does.
let coalescing = null;
const endCoalescing = () => { coalescing = null; };

const setProject = (next, { pushHistory = true, persist = true, coalesce = null } = {}) => {
    const cleaned = Project.cleanProject(next);
    if (!cleaned) return false;
    const continuing = coalesce !== null && coalesce === coalescing;
    if (pushHistory && project && !continuing) {
        history.push(structuredClone(project));
        if (history.length > HISTORY_LIMIT) history.shift();
        future = [];
    }
    coalescing = pushHistory ? coalesce : null;
    project = cleaned;
    renderProject();
    if (persist) schedulePersist();
    return true;
};

const undo = () => {
    if (!history.length || !project) return;
    endCoalescing();
    future.push(structuredClone(project));
    project = history.pop();
    selectedId = project.objects.some(object => object.id === selectedId) ? selectedId : null;
    routeSession = null;
    ui.finishRoute.hidden = true;
    renderProject();
    schedulePersist();
};

const redo = () => {
    if (!future.length || !project) return;
    endCoalescing();
    history.push(structuredClone(project));
    project = future.pop();
    selectedId = project.objects.some(object => object.id === selectedId) ? selectedId : null;
    renderProject();
    schedulePersist();
};

const toolName = tool => document.querySelector(`[data-tool="${tool}"] .tool-name`)?.textContent
    || tool;

// Placement tools stay armed until the user leaves them. Snapping back to
// Select after one symbol made marking a pitch a click-a-tool-per-symbol chore;
// Esc and V are the way out, and the status line says so.
const setTool = tool => {
    activeTool = tool;
    document.querySelectorAll('[data-tool]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
    });
    // A placement tool's panel describes the mark it is about to place, so
    // arming one lets go of the current selection — including a route that the
    // switch itself just finished. Select keeps it: pressing V after placing a
    // symbol is how the user goes on to adjust that symbol.
    if (tool !== 'select') selectedId = null;
    if (tool !== 'route' && routeSession) finishRoute(false);
    // Which handles are on screen depends on the armed tool, so the canvas has
    // to be repainted when it changes.
    else if (project) renderProject();
    setEditorStatus(tool === 'select'
        ? 'Select a mark to move or restyle it.'
        : tool === 'route'
            ? 'Click along the route. Double-click, right-click, or press Enter to finish.'
            : `${toolName(tool)}: click the photo to place one. Esc returns to Select.`);
};

const pointerPoint = event => {
    const rect = ui.overlay.getBoundingClientRect();
    return [
        (event.clientX - rect.left) * project.image.width / rect.width,
        (event.clientY - rect.top) * project.image.height / rect.height,
    ];
};

const defaultStyle = () => ({
    color: styleDefaults.color,
    scale: styleDefaults.scale,
    opacity: styleDefaults.opacity,
});

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

const pressOf = event => ({ x: event.clientX, y: event.clientY, at: event.timeStamp });

const isDoublePress = (previous, press) => !!previous
    && press.at - previous.at <= DOUBLE_PRESS_MS
    && Math.abs(press.x - previous.x) <= DOUBLE_PRESS_SLOP
    && Math.abs(press.y - previous.y) <= DOUBLE_PRESS_SLOP;

const addRoutePoint = (point, press) => {
    if (routeSession && isDoublePress(routeSession.lastPress, press)) {
        finishRoute(false);
        return;
    }
    if (!routeSession) {
        routeSession = {
            id: crypto.randomUUID(),
            baseline: structuredClone(project),
            points: [point],
            cursor: null,
            historyPushed: false,
            lastPress: press,
        };
        ui.finishRoute.hidden = false;
        setEditorStatus('Route started. Click the next point; double-click, right-click, or Enter finishes.');
        renderRoutePreview();
        return;
    }
    routeSession.lastPress = press;
    routeSession.points.push(point);
    const object = {
        id: routeSession.id,
        type: 'route',
        // Controls stay empty on purpose: a smooth route derives them from its
        // own points, so the curve survives every point added after it.
        geometry: { points: routeSession.points, controls: [] },
        style: {
            color: styleDefaults.color,
            width: styleDefaults.width,
            stroke: styleDefaults.stroke,
            end: styleDefaults.end,
            opacity: styleDefaults.opacity,
            smooth: styleDefaults.smooth,
        },
    };
    if (routeSession.points.length === 2) {
        history.push(structuredClone(routeSession.baseline));
        if (history.length > HISTORY_LIMIT) history.shift();
        future = [];
        routeSession.historyPushed = true;
        project = Project.addObject(routeSession.baseline, object);
    } else {
        project = Project.updateObject(project, routeSession.id, { geometry: object.geometry });
    }
    selectedId = routeSession.id;
    renderProject();
};

const finishRoute = cancel => {
    if (!routeSession) return;
    if (cancel) {
        project = routeSession.baseline;
        if (routeSession.historyPushed) history.pop();
        selectedId = null;
        setEditorStatus('Route cancelled.');
    } else if (routeSession.points.length < 2) {
        setEditorStatus('Route discarded because it needs at least two points.');
    } else {
        setEditorStatus('Route added. Click to start another, or press V to select.');
        schedulePersist();
    }
    routeSession = null;
    ui.finishRoute.hidden = true;
    renderProject();
};

const addPointObject = (type, point) => {
    const base = {
        id: crypto.randomUUID(),
        type,
        geometry: { x: point[0], y: point[1], rotation: 0 },
        style: defaultStyle(),
    };
    let object = base;
    if (type === 'pitch') {
        object = {
            ...base,
            pitch: Number(ui.pitch.value || 1),
            style: { ...base.style, background: true },
        };
    }
    if (type === 'text') {
        object = {
            ...base,
            text: 'Label',
            style: { ...base.style, align: 'left', background: true },
        };
    }
    const next = Project.addObject(project, object);
    if (!next) return;
    selectedId = object.id;
    setProject(next);
    setEditorStatus(`${toolName(type)} placed. Click to place another, or press V to select.`);
    if (type === 'text') {
        ui.text.focus();
        ui.text.select();
    }
};

const translatedGeometry = (object, dx, dy) => {
    if (object.type !== 'route') {
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

const beginDrag = (event, objectId, vertex = null) => {
    const object = project.objects.find(candidate => candidate.id === objectId);
    if (!object) return;
    endCoalescing();
    dragSession = {
        start: pointerPoint(event),
        baseline: structuredClone(project),
        object: structuredClone(object),
        vertex,
        moved: false,
    };
    history.push(structuredClone(project));
    if (history.length > HISTORY_LIMIT) history.shift();
    future = [];
    ui.overlay.setPointerCapture?.(event.pointerId);
};

const moveDrag = event => {
    if (routeSession) {
        routeSession.cursor = pointerPoint(event);
        renderRoutePreview();
    }
    if (!dragSession) return;
    const point = pointerPoint(event);
    const dx = point[0] - dragSession.start[0];
    const dy = point[1] - dragSession.start[1];
    if (Math.abs(dx) + Math.abs(dy) < 0.01) return;
    dragSession.moved = true;
    let geometry;
    if (dragSession.object.type === 'route' && dragSession.vertex != null) {
        const index = dragSession.vertex;
        const points = dragSession.object.geometry.points.map((point, at) => at === index
            ? [point[0] + dx, point[1] + dy]
            : point);
        // Clearing the controls hands the curve back to the model, the same way
        // adding a point does. Translating only this vertex's own handles left
        // its neighbours' tangents aimed at where the vertex used to be, so a
        // smooth route kinked away from the point the user was dragging.
        geometry = { points, controls: [] };
    } else {
        geometry = translatedGeometry(dragSession.object, dx, dy);
    }
    project = Project.updateObject(dragSession.baseline, dragSession.object.id, { geometry });
    renderProject();
};

const endDrag = () => {
    if (!dragSession) return;
    if (!dragSession.moved) history.pop();
    else schedulePersist();
    dragSession = null;
    updateHistoryButtons();
};

const onPointerDown = event => {
    if (!project || busy || event.button !== 0) return;
    const vertexNode = activeTool === 'select' ? event.target.closest?.('[data-vertex]') : null;
    if (vertexNode) {
        selectedId = vertexNode.dataset.objectId;
        renderProject();
        beginDrag(event, selectedId, Number(vertexNode.dataset.vertex));
        return;
    }
    if (activeTool === 'route') {
        addRoutePoint(pointerPoint(event), pressOf(event));
        return;
    }
    if (activeTool !== 'select') {
        addPointObject(activeTool, pointerPoint(event));
        return;
    }
    const objectNode = event.target.closest?.('[data-bpb-object]');
    selectedId = objectNode?.getAttribute('data-bpb-object') || null;
    renderProject();
    if (selectedId) beginDrag(event, selectedId);
};

// `coalesce` names the control being dragged or typed into; it is scoped to the
// mark so moving to a different one always starts a new Undo step.
const updateSelected = (patch, { coalesce = null } = {}) => {
    const object = selectedObject();
    if (!object) return;
    if (patch.style) {
        styleDefaults = {
            ...styleDefaults,
            ...Object.fromEntries(Object.entries(patch.style)
                .filter(([key]) => key in styleDefaults)),
        };
    }
    setProject(Project.updateObject(project, object.id, patch), {
        coalesce: coalesce && `${coalesce}:${object.id}`,
    });
};

// One control, two subjects: with a mark selected it restyles that mark, and
// with only a tool armed it sets what the next mark will be. Presetting a tool
// touches nothing on the photo, so it is deliberately not an Undo step.
const applyStyle = (patch, { coalesce = null, geometry = null } = {}) => {
    const object = selectedObject();
    if (!object && !inspectorType()) return;
    if (object) {
        updateSelected({
            style: { ...object.style, ...patch },
            ...(geometry ? { geometry: { ...object.geometry, ...geometry } } : {}),
        }, { coalesce });
        return;
    }
    styleDefaults = {
        ...styleDefaults,
        ...Object.fromEntries(Object.entries(patch).filter(([key]) => key in styleDefaults)),
    };
};

const duplicateSelected = () => {
    const object = selectedObject();
    if (!object) return;
    const copy = structuredClone(object);
    copy.id = crypto.randomUUID();
    copy.geometry = translatedGeometry(copy, 24, 24);
    const next = Project.addObject(project, copy);
    if (!next) return;
    selectedId = copy.id;
    setProject(next);
};

const deleteSelected = () => {
    if (!selectedId) return;
    const next = Project.removeObjects(project, [selectedId]);
    selectedId = null;
    setProject(next);
};

const nudgeSelected = (dx, dy) => {
    const object = selectedObject();
    if (!object) return;
    updateSelected({ geometry: translatedGeometry(object, dx, dy) }, { coalesce: 'nudge' });
};

const loadBundle = async bundle => {
    if (!bundle?.photo || !bundle.project || !bundle.original) {
        toast('The editable original is not available on this device.');
        return false;
    }
    closeSource();
    sourceBitmap = await decodeBlob(bundle.original);
    project = bundle.project;
    photo = bundle.photo;
    originalBlob = bundle.original;
    thumbnailBlob = bundle.thumbnail || await makeThumbnail(sourceBitmap);
    history = [];
    future = [];
    selectedId = null;
    ui.title.value = photo.title;
    ui.alt.value = photo.alt;
    setSourceDisplay(originalBlob);
    ui.editorEmpty.hidden = true;
    ui.editorWorkspace.hidden = false;
    renderProject();
    setSaveStatus('Saved on this device');
    setView('editor');
    return true;
};

// No size gate on the way in. The export is re-encoded from the decoded pixels,
// so the file picked here does not decide the upload's size — a 60 MB source
// routinely exports to a few MB of JPEG, and refusing to open it withheld an
// edit that would have uploaded fine. Whether the browser can decode it is the
// real constraint, and the decode itself answers that.
const chooseFile = async file => {
    if (!file) return;
    if (file.size <= 0) {
        toast('That file is empty.');
        return;
    }
    setBusy(true, 'Reading photo…');
    try {
        const bitmap = await decodeBlob(file);
        if (!bitmap.width || !bitmap.height) throw new Error('The image has no dimensions.');
        const sourceSha256 = await Renderer.sha256(file);
        closeSource();
        sourceBitmap = bitmap;
        originalBlob = file;
        thumbnailBlob = await makeThumbnail(bitmap);
        const localId = crypto.randomUUID();
        project = Project.createProject({
            localId,
            width: bitmap.width,
            height: bitmap.height,
            sourceSha256,
        });
        if (file.type === 'image/png') {
            project = Project.cleanProject({
                ...project,
                export: { mime: 'image/png', quality: 1 },
            });
        }
        photo = null;
        selectedId = null;
        history = [];
        future = [];
        ui.title.value = defaultTitle(file.name);
        ui.alt.value = '';
        setSourceDisplay(file);
        ui.editorEmpty.hidden = true;
        ui.editorWorkspace.hidden = false;
        renderProject();
        // The title is filled from the file name and the description is
        // optional, so the draft is already valid — autosave it rather than
        // waiting for an edit that may never come.
        setSaveStatus('Not saved yet');
        setEditorStatus('Photo stays local until you choose Upload and insert.');
        schedulePersist();
        ui.alt.focus();
    } catch {
        toast('This browser could not decode that image.');
    } finally {
        setBusy(false);
    }
};

const uploadAndInsert = async () => {
    if (busy || !project || !sourceBitmap) return;
    if (PUBLISHED_STATES.includes(photo?.remote.state)) {
        toast('This photo is already on ImgBB. Use “Edit as new version” in the library to change it.');
        return;
    }
    if (!await persistDraft({ required: true })) return;
    if (!await requestPermission()) {
        toast('Allow Better Peakbagger to reach api.imgbb.com, then choose Upload again.');
        return;
    }
    const key = await leaseCredential();
    if (!key) {
        toast('Connect an ImgBB API key before uploading.');
        ui.key.focus();
        return;
    }
    setBusy(true, 'Preparing image…');
    let operation = null;
    let uploadingPhoto = null;
    let providerResponse = null;
    try {
        // Deliberately no local size check: the ceiling belongs to the ImgBB
        // account, not to this extension, and it says so in its own rejection.
        const exported = await Renderer.exportProject({ project, source: sourceBitmap });
        ui.exportSummary.textContent = `${formatBytes(exported.bytes)} ${exported.mime.replace('image/', '').toUpperCase()}`
            + ` · ${exported.width} × ${exported.height}`;
        const exportMetadata = {
            mime: exported.mime,
            bytes: exported.bytes,
            width: exported.width,
            height: exported.height,
            sha256: exported.sha256,
        };
        uploadingPhoto = Library.beginUpload(photo, exportMetadata);
        await store.putPhoto(uploadingPhoto);
        operation = {
            operationId: crypto.randomUUID(),
            localId: photo.localId,
            state: 'request-started',
            export: exportMetadata,
            returnToken: RETURN_TOKEN || null,
            updatedAt: new Date().toISOString(),
        };
        await store.putOperation(operation);
        setEditorStatus('Uploading to ImgBB…');
        providerResponse = await ImgbbClient.upload({
            fetch: globalThis.fetch.bind(globalThis),
            key,
            blob: exported.blob,
            name: photo.title,
        });
        operation = {
            ...operation,
            state: 'response-received',
            remote: providerResponse.remote,
            deleteUrl: providerResponse.deleteUrl,
            updatedAt: new Date().toISOString(),
        };
        await store.putOperation(operation);
        setEditorStatus('Saving to library…');
        photo = Library.completeUpload(uploadingPhoto, exportMetadata, providerResponse.remote);
        await store.commitUpload({ photo, deleteUrl: providerResponse.deleteUrl });
        operation = { ...operation, state: 'catalog-committed', updatedAt: new Date().toISOString() };
        await store.putOperation(operation);

        if (RETURN_TOKEN) {
            setEditorStatus('Inserting into report…');
            const inserted = await send({
                type: 'PHOTO_INSERT_COMMIT',
                returnToken: RETURN_TOKEN,
                localPhotoId: photo.localId,
                url: photo.remote.url,
                alt: photo.alt,
            });
            if (!inserted?.ok) {
                throw new ImgbbClient.ImgbbError(
                    'insert-failed',
                    inserted?.error?.message
                        || 'The photo was uploaded but could not be inserted into the report.',
                );
            }
            photo = Library.addReference(photo, {
                kind: inserted.identity?.aid ? 'ascent' : 'ascent-draft',
                cid: inserted.identity?.cid ?? null,
                aid: inserted.identity?.aid ?? null,
                pid: inserted.identity?.pid ?? null,
                insertedAt: new Date().toISOString(),
            });
            await store.putPhoto(photo);
            await store.deleteOperation(operation.operationId);
            setEditorStatus('Uploaded and inserted. You can close this tab.');
            toast('Photo uploaded and inserted into the report. You can close this tab.');
        } else {
            await store.deleteOperation(operation.operationId);
            setEditorStatus('Uploaded to ImgBB and saved in the library.');
            toast('Photo uploaded to ImgBB.');
        }
        notifyBackupChanged();
        await renderLibrary();
    } catch (error) {
        const publicFailure = ImgbbClient.publicError(error);
        if ((publicFailure.ambiguous || providerResponse) && uploadingPhoto) {
            photo = Library.markOutcomeUnknown(uploadingPhoto);
            await store.putPhoto(photo).catch(() => {});
        } else if (uploadingPhoto && operation?.state === 'request-started') {
            photo = Library.resetUpload(uploadingPhoto);
            await store.putPhoto(photo).catch(() => {});
            await store.deleteOperation(operation.operationId).catch(() => {});
        }
        setEditorStatus(publicFailure.message);
        if (providerResponse?.remote?.url) {
            toast(
                `ImgBB accepted the image, but Better Peakbagger could not finish cataloging it. `
                + `Save this URL: ${providerResponse.remote.url}`,
                {
                    action: 'Copy URL',
                    onAction: () => void navigator.clipboard.writeText(providerResponse.remote.url),
                    duration: 0,
                },
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
    const operations = await store.getOperations();
    let changed = false;
    for (const operation of operations) {
        const bundle = await store.getBundle(operation.localId);
        if (!bundle.photo) {
            await store.deleteOperation(operation.operationId);
            continue;
        }
        try {
            if (operation.state === 'request-started' && bundle.photo.remote.state === 'uploading') {
                await store.putPhoto(Library.markOutcomeUnknown(bundle.photo));
                changed = true;
            }
            if (operation.state === 'response-received') {
                const completed = Library.completeUpload(
                    bundle.photo,
                    operation.export,
                    operation.remote,
                    operation.updatedAt,
                );
                if (completed) {
                    await store.commitUpload({ photo: completed, deleteUrl: operation.deleteUrl });
                    await store.putOperation({ ...operation, state: 'catalog-committed' });
                    changed = true;
                }
            }
        } catch {
            // Keep the journal for an explicit recovery attempt.
        }
    }
    if (changed) notifyBackupChanged();
};

const statusLabels = item => {
    const remote = item.remote.state === 'outcome-unknown' ? 'Upload outcome unknown'
        : item.remote.state === 'unreachable' ? 'Image unreachable'
            : item.remote.state === 'uploaded' ? 'Uploaded'
                : item.remote.state === 'uploading' ? 'Uploading'
                    : 'Local draft';
    const use = item.references.length ? 'Used in report' : item.remote.state === 'uploaded' ? 'Not inserted' : null;
    const backup = item.backup.state === 'pending' ? 'Backup pending'
        : item.backup.state === 'failed' ? 'Backup failed'
            : item.backup.state === 'current' ? 'Backed up' : null;
    return [remote, use, backup].filter(Boolean);
};

const makeButton = (label, handler, className = 'quiet-button') => {
    const button = element('button', className, label);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
};

const insertFromLibrary = async item => {
    if (!RETURN_TOKEN) {
        await navigator.clipboard.writeText(item.remote.url);
        toast('Image URL copied.');
        return;
    }
    const inserted = await send({
        type: 'PHOTO_INSERT_COMMIT',
        returnToken: RETURN_TOKEN,
        localPhotoId: item.localId,
        url: item.remote.url,
        alt: item.alt,
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
    await store.putPhoto(referenced);
    notifyBackupChanged();
    toast('Photo inserted into the report. You can close this tab.');
    await renderLibrary();
};

const editAsNewVersion = async item => {
    const bundle = await store.getBundle(item.localId);
    if (!bundle.original || !bundle.project) {
        toast('The original photo is not available on this device.');
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
        title: `${item.title} revision`.slice(0, Library.TITLE_LIMIT),
        alt: item.alt,
        source: item.source,
        parentLocalId: item.localId,
        now,
    });
    await store.putDraft({
        photo: nextPhoto,
        project: nextProject,
        original: bundle.original,
        thumbnail: bundle.thumbnail || await makeThumbnail(await decodeBlob(bundle.original)),
    });
    notifyBackupChanged();
    await loadBundle(await store.getBundle(localId));
    toast('Editing a new version. The existing image will stay unchanged.');
};

// The return leg of Download project. A bundle whose id is still free is
// reunited with its own record, so a restored GitHub catalog entry, its report
// references, and its public URL all find their pixels again. A bundle whose id
// is already here becomes a new local draft instead: two catalog records
// claiming one published ImgBB asset could each be "removed" independently, and
// the second removal would look like it had freed something it had not.
const importProject = async file => {
    if (!file) return;
    // The library view has no status line, so the toast carries the progress
    // and the result replaces it.
    setBusy(true);
    toast('Reading project bundle…', { duration: 0 });
    try {
        const raw = await Archive.readProjectArchive(file);
        const project = Project.cleanProject(raw.project);
        const imported = Library.cleanPhoto(raw.photo);
        if (!project || !imported || project.localId !== imported.localId) {
            throw new Archive.ArchiveError('That project bundle is not a readable Better Peakbagger project.');
        }
        const sha256 = await Renderer.sha256(raw.original);
        if (sha256 !== project.image.sourceSha256 || sha256 !== imported.source.sha256) {
            throw new Archive.ArchiveError('That bundle’s image does not match its project.');
        }
        const bitmap = await decodeBlob(raw.original);
        const thumbnail = await makeThumbnail(bitmap);
        bitmap.close?.();

        const existing = (await store.getBundle(imported.localId)).photo;
        const now = new Date().toISOString();
        const localId = existing ? crypto.randomUUID() : imported.localId;
        const photo = existing
            ? Library.createDraft({
                localId,
                title: `${imported.title} (imported)`.slice(0, Library.TITLE_LIMIT),
                alt: imported.alt,
                source: imported.source,
                parentLocalId: imported.localId,
                now,
            })
            : Library.cleanPhoto({
                ...imported,
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
            photo,
            project: Project.cleanProject({ ...project, localId, updatedAt: now }),
            original: raw.original,
            thumbnail,
        });
        notifyBackupChanged();
        await renderLibrary();
        toast(existing
            ? 'Imported as a new local draft, because that photo is already in this library.'
            : `Imported “${photo.title}”.`);
    } catch (error) {
        toast(error instanceof Archive.ArchiveError
            ? error.message
            : 'That project bundle could not be imported.', { duration: 9000 });
    } finally {
        ui.importProject.value = '';
        setBusy(false);
    }
};

const downloadProject = async item => {
    const bundle = await store.getBundle(item.localId);
    if (!bundle.project || !bundle.original) {
        toast('The editable project is not available on this device.');
        return;
    }
    if (!confirm(
        'This project bundle includes the original file and any metadata it contains. Download it?',
    )) return;
    const blob = await Archive.createProjectArchive({
        project: bundle.project,
        photo: bundle.photo,
        original: bundle.original,
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${item.localId}.bpb-photo`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const moveToDeleted = async item => {
    if (!confirm(
        `Move “${item.title}” to Recently Deleted? Its ImgBB image and report URLs will not change.`,
    )) return;
    const deleted = Library.markDeleted(item);
    await store.putPhoto(deleted);
    notifyBackupChanged();
    undoDeleted = item;
    toast('Moved to Recently Deleted. The remote image was not deleted.', {
        action: 'Undo',
        onAction: async () => {
            await store.putPhoto(Library.restoreDeleted(deleted));
            notifyBackupChanged();
            undoDeleted = null;
            ui.toast.hidden = true;
            await renderLibrary();
        },
        duration: 10000,
    });
    await renderLibrary();
};

const restoreLibraryItem = async item => {
    await store.putPhoto(Library.restoreDeleted(item));
    notifyBackupChanged();
    toast('Photo restored to the library.');
    await renderLibrary();
};

const cardFor = async item => {
    const card = element('article', 'photo-card');
    const bundle = await store.getBundle(item.localId);
    if (bundle.thumbnail) {
        const url = URL.createObjectURL(bundle.thumbnail);
        libraryObjectUrls.push(url);
        const image = element('img');
        image.src = url;
        image.alt = '';
        card.append(image);
    } else if (item.remote.thumbnailUrl) {
        const image = element('img');
        image.src = item.remote.thumbnailUrl;
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', async () => {
            if (item.remote.state === 'uploaded') {
                await store.putPhoto(Library.markUnreachable(item));
                notifyBackupChanged();
                toast('The remote thumbnail could not be loaded.');
            }
        }, { once: true });
        card.append(image);
    } else {
        card.append(element('div', 'photo-placeholder', 'Local topo draft'));
    }

    const body = element('div', 'photo-card-body');
    body.append(element('h3', '', item.title));
    if (item.alt) body.append(element('p', '', item.alt));
    body.append(element('p', '', `${item.source.width} × ${item.source.height} · `
        + `${formatBytes(item.export?.bytes || item.source.bytes)} · `
        + new Date(item.updatedAt).toLocaleDateString()));
    const chips = element('div', 'status-chips');
    statusLabels(item).forEach(label => chips.append(element('span', 'status-chip', label)));
    body.append(chips);
    const actions = element('div', 'card-actions');
    if (!item.deletedAt && ['uploaded', 'unreachable'].includes(item.remote.state)) {
        actions.append(makeButton(RETURN_TOKEN ? 'Insert' : 'Copy URL',
            () => void insertFromLibrary(item), 'secondary-button'));
    }
    if (!item.deletedAt && item.assets.originalRetained && item.assets.projectRetained) {
        actions.append(makeButton('Edit as new version', () => void editAsNewVersion(item)));
        actions.append(makeButton('Download project', () => void downloadProject(item)));
    }
    if (!item.deletedAt && item.remote.viewerUrl) {
        actions.append(makeButton('Open on ImgBB',
            () => void ext.tabs.create({ url: item.remote.viewerUrl })));
    }
    actions.append(item.deletedAt
        ? makeButton('Restore', () => void restoreLibraryItem(item), 'secondary-button')
        : makeButton('Remove…', () => void moveToDeleted(item), 'danger-button'));
    body.append(actions);
    card.append(body);
    return card;
};

const pruneDeletedAssets = async items => {
    const cutoff = Date.now() - RECENTLY_DELETED_MS;
    for (const item of items) {
        if (item.deletedAt && Date.parse(item.deletedAt) <= cutoff
            && (item.assets.originalRetained || item.assets.projectRetained || item.assets.thumbnailRetained)) {
            await store.removeLocalAssets(item.localId, new Date().toISOString());
        }
    }
};

const renderStorageEstimate = async () => {
    if (!navigator.storage?.estimate) return;
    const estimate = await navigator.storage.estimate();
    ui.storageSummary.textContent = Number.isFinite(estimate.usage)
        ? `${formatBytes(estimate.usage)} used by this extension profile`
        : '';
};

async function drawLibrary() {
    libraryObjectUrls.forEach(url => URL.revokeObjectURL(url));
    libraryObjectUrls = [];
    const all = await store.listPhotos({ includeDeleted: true });
    await pruneDeletedAssets(all);
    const filter = ui.filter.value;
    const items = filter === 'recently-deleted'
        ? all.filter(item => item.deletedAt)
        : Library.search(all, ui.search.value, filter);
    // Build every card before touching the grid: an incremental append leaves a
    // half-drawn list on screen for as long as the thumbnail reads take.
    const cards = [];
    for (const item of items) cards.push(await cardFor(item));
    ui.libraryList.replaceChildren(...cards);
    ui.libraryEmpty.hidden = items.length > 0;
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

const formatBackupTime = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'unknown time';
};

const setPhotoBackupBusy = value => {
    photoBackupBusy = value;
    ui.backupNow.disabled = value;
    ui.backupNow.setAttribute('aria-busy', String(value));
};

const refreshPhotoBackupStatus = async () => {
    const response = await send({ type: 'GITHUB_PHOTOS_STATUS' });
    if (!response?.ok) {
        ui.backupStatus.textContent = 'GitHub recovery is unavailable.';
        ui.backupNow.disabled = true;
        return;
    }
    ui.backupNow.disabled = !response.connected || photoBackupBusy;
    if (!response.connected) {
        ui.backupStatus.textContent = 'Connect a GitHub backup repository in Settings to enable recovery.';
        return;
    }
    const repository = response.repo?.fullName
        || [response.repo?.owner, response.repo?.name].filter(Boolean).join('/');
    const state = response.state;
    if (state?.syncedAt) {
        ui.backupStatus.textContent = `Backed up to ${repository} · ${formatBackupTime(state.syncedAt)}`;
    } else if (state?.restoredAt) {
        ui.backupStatus.textContent = `Restored from ${repository} · ${formatBackupTime(state.restoredAt)}`;
    } else {
        ui.backupStatus.textContent = `Ready to back up metadata to ${repository}.`;
    }
};

const backupPhotoLibrary = async () => {
    if (photoBackupBusy) return;
    setPhotoBackupBusy(true);
    ui.backupStatus.textContent = 'Backing up photo metadata…';
    const response = await send({ type: 'GITHUB_PHOTOS_BACKUP' });
    setPhotoBackupBusy(false);
    if (response?.ok) {
        toast('Photo-library metadata backed up to GitHub.');
        await renderLibrary();
        await refreshPhotoBackupStatus();
        return;
    }
    ui.backupStatus.textContent = response?.error?.code === 'photo-backup-conflict'
        ? `Backup conflict in ${response.error.conflictCount || 1} photo record(s). `
            + 'Restore from Settings and review before backing up again.'
        : response?.error?.message || 'The photo-library backup failed. Try again.';
};

const bindInspector = () => {
    ui.color.addEventListener('change', () => applyStyle({ color: ui.color.value }));
    ui.routeWidth.addEventListener('input', () => {
        if (inspectorType() === 'route') {
            const width = Number(ui.routeWidth.value);
            ui.routeWidthValue.textContent = pixels(width);
            applyStyle({ width }, { coalesce: 'width' });
        }
    });
    ui.routeStroke.addEventListener('change', () => {
        if (inspectorType() === 'route') applyStyle({ stroke: ui.routeStroke.value });
    });
    ui.routeArrow.addEventListener('change', () => {
        if (inspectorType() === 'route') {
            applyStyle({ end: ui.routeArrow.checked ? 'arrow' : 'none' });
        }
    });
    ui.routeSmooth.addEventListener('change', () => {
        if (inspectorType() === 'route') {
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
        if (type && type !== 'route') {
            const scale = Number(ui.scale.value);
            ui.scaleValue.textContent = pixels(Renderer.objectSizePixels(type, project.image, scale));
            applyStyle({ scale }, { coalesce: 'scale' });
        }
    });
    ui.rotation.addEventListener('input', () => {
        const object = selectedObject();
        const rotation = Number(ui.rotation.value);
        ui.rotationValue.textContent = `${rotation}°`;
        if (object && object.type !== 'route') {
            updateSelected({ geometry: { ...object.geometry, rotation } }, { coalesce: 'rotation' });
        }
    });
    ui.pitch.addEventListener('change', () => {
        const object = selectedObject();
        if (object?.type === 'pitch') updateSelected({ pitch: Number(ui.pitch.value) });
    });
    ui.text.addEventListener('input', () => {
        const object = selectedObject();
        if (object?.type === 'text' && ui.text.value.trim()) {
            updateSelected({ text: ui.text.value }, { coalesce: 'text' });
        }
    });
    // A range input fires `change` when the drag ends and a text field when it
    // loses focus, so the next gesture on the same control is its own Undo step
    // rather than being folded into the last one.
    for (const control of [ui.opacity, ui.routeWidth, ui.scale, ui.rotation, ui.text]) {
        control.addEventListener('change', endCoalescing);
    }
    ui.align.addEventListener('change', () => {
        const object = selectedObject();
        if (object?.type === 'text') {
            updateSelected({ style: { ...object.style, align: ui.align.value } });
        }
    });
    ui.background.addEventListener('change', () => {
        const object = selectedObject();
        if (object && ['pitch', 'text'].includes(object.type)) {
            updateSelected({ style: { ...object.style, background: ui.background.checked } });
        }
    });
};

const bindEvents = () => {
    ui.showEditor.addEventListener('click', () => setView('editor'));
    ui.showLibrary.addEventListener('click', () => setView('library'));
    ui.saveKey.addEventListener('click', () => void saveCredential());
    ui.removeKey.addEventListener('click', () => void removeCredential());
    // Settings owns the same device-local key, so a claim made when this tab
    // loaded can be stale by the time the user comes back to it. Never refresh
    // while they are typing in the form the answer would hide.
    window.addEventListener('focus', () => {
        if (ui.credentialForm.contains(document.activeElement)) return;
        void refreshCredential();
    });
    ui.file.addEventListener('change', () => void chooseFile(ui.file.files?.[0]));
    ui.title.addEventListener('input', schedulePersist);
    ui.alt.addEventListener('input', schedulePersist);
    ui.undo.addEventListener('click', undo);
    ui.redo.addEventListener('click', redo);
    document.querySelectorAll('[data-tool]').forEach(button => {
        button.addEventListener('click', () => setTool(button.dataset.tool));
    });
    ui.finishRoute.addEventListener('click', () => finishRoute(false));
    ui.overlay.addEventListener('pointerdown', onPointerDown);
    ui.overlay.addEventListener('pointermove', moveDrag);
    ui.overlay.addEventListener('pointerup', endDrag);
    ui.overlay.addEventListener('pointercancel', endDrag);
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
        if (selectedId) setProject(Project.reorderObject(project, selectedId, 'back'));
    });
    ui.bringFront.addEventListener('click', () => {
        if (selectedId) setProject(Project.reorderObject(project, selectedId, 'front'));
    });
    ui.duplicate.addEventListener('click', duplicateSelected);
    ui.deleteObject.addEventListener('click', deleteSelected);
    ui.clear.addEventListener('click', () => {
        const count = project?.objects.length || 0;
        if (!count || !confirm(`Remove all ${count} annotation${count === 1 ? '' : 's'}? You can Undo this.`)) {
            return;
        }
        selectedId = null;
        setProject(Project.removeObjects(project, project.objects.map(object => object.id)));
        toast(`${count} annotation${count === 1 ? '' : 's'} removed.`, {
            action: 'Undo',
            onAction: undo,
        });
    });
    ui.upload.addEventListener('click', () => void uploadAndInsert());
    ui.search.addEventListener('input', () => void renderLibrary());
    ui.filter.addEventListener('change', () => void renderLibrary());
    ui.importProject.addEventListener('change', () => void importProject(ui.importProject.files?.[0]));
    ui.backupNow.addEventListener('click', () => void backupPhotoLibrary());
    ui.toastAction.addEventListener('click', () => {
        if (undoDeleted) undoDeleted = null;
    });
    bindInspector();

    document.addEventListener('keydown', event => {
        const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
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
        if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === 'Escape') {
            // One predictable ladder out of whatever the user is in the middle
            // of: abandon the route, then disarm the tool, then deselect.
            if (routeSession) finishRoute(true);
            else if (activeTool !== 'select') setTool('select');
            else {
                selectedId = null;
                renderProject();
            }
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            deleteSelected();
        } else if (toolShortcuts.has(event.key.toLowerCase())) {
            setTool(toolShortcuts.get(event.key.toLowerCase()));
        } else if (event.key === 'Enter' && routeSession) finishRoute(false);
        else if (event.key.startsWith('Arrow')) {
            const step = event.shiftKey ? 10 : 1;
            const directions = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
            };
            event.preventDefault();
            nudgeSelected(...directions[event.key]);
        }
    });
    // Releasing the key ends the nudge, so a held arrow is one Undo and the
    // next press is another.
    document.addEventListener('keyup', event => {
        if (event.key.startsWith('Arrow')) endCoalescing();
    });
    window.addEventListener('beforeunload', () => {
        closeSource();
        libraryObjectUrls.forEach(url => URL.revokeObjectURL(url));
        store?.close();
    });
};

// The rail's own <kbd> hints are the single source for the shortcuts, so a key
// shown on a button is always the key that arms it.
const toolShortcuts = new Map();

const paintToolRail = () => {
    for (const button of document.querySelectorAll('[data-tool]')) {
        const key = button.querySelector('kbd')?.textContent.trim().toLowerCase();
        if (key?.length === 1) toolShortcuts.set(key, button.dataset.tool);
        const slot = button.querySelector('[data-symbol]');
        if (!slot) continue;
        // Painted from the same geometry the export uses: the symbol a climber
        // is shown on the button cannot drift from the one on the photo.
        const parsed = new DOMParser().parseFromString(
            Renderer.markerSymbolSvg(slot.dataset.symbol),
            'image/svg+xml',
        );
        slot.replaceChildren(document.importNode(parsed.documentElement, true));
    }
};

const initialize = async () => {
    for (let number = 1; number <= 50; number += 1) {
        const option = element('option', '', `P${number}`);
        option.value = String(number);
        ui.pitch.append(option);
    }
    paintToolRail();
    bindEvents();
    store = await Store.createPhotoStore();
    await recoverOperations();
    await refreshCredential();
    await refreshPhotoBackupStatus();
    ui.upload.textContent = RETURN_TOKEN ? 'Upload and insert' : 'Upload to ImgBB';
    setView(START_MODE === 'library' ? 'library' : 'editor');
    await renderLibrary();
};

void initialize().catch(() => {
    toast('The local photo library could not be opened. Reload and try again.', { duration: 0 });
});
