import { Profile } from './models/profile.js';
import { evaluateHttpPolicy } from './http-policy.js';
import { ProfileRepository } from './storage/profile-repository.js';
import { SecureTokenStore } from './storage/secure-token-store.js';
import { ConnectionCoordinator } from './connection-coordinator.js';
import { AppLifecycle, AppView } from './app-lifecycle.js';
import { SessionMonitor } from './session-monitor.js';
import { LiveModeController } from './live-mode-controller.js';
import { ReplayResume } from './replay-resume.js';

const profileRepo = new ProfileRepository();
const tokenStore = new SecureTokenStore();
const coordinator = new ConnectionCoordinator(profileRepo, tokenStore);
const liveModeController = new LiveModeController();
const replayResume = new ReplayResume();

let currentProfiles: Profile[] = [];
let selectedProfileId: string | null = null;

function requiredEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required element: #${id}`);
  }
  return el as T;
}

// Required shell elements
const listEl = requiredEl<HTMLDivElement>('profile-list');
const modalEl = requiredEl<HTMLDivElement>('modal');
const modalTitleEl = requiredEl<HTMLHeadingElement>('modal-title');
const launchBtn = requiredEl<HTMLButtonElement>('btn-launch');
const addBtn = requiredEl<HTMLButtonElement>('btn-add');
const saveBtn = requiredEl<HTMLButtonElement>('btn-save');
const cancelBtn = requiredEl<HTMLButtonElement>('btn-cancel');

// Optional web container elements (older/stale HTML should not break profile picker)
const webContainer = document.getElementById('web-container') as HTMLDivElement | null;
const webFrame = document.getElementById('web-frame') as HTMLIFrameElement | null;
const switchProfileBtn = document.getElementById('btn-switch-profile') as HTMLButtonElement | null;

// Optional Live Mode UI elements (picker + embedded web container)
const liveModeToggleBtn = document.getElementById('btn-live-mode') as HTMLButtonElement | null;
const liveModeStatusEl = document.getElementById('live-mode-status') as HTMLSpanElement | null;
const liveModeToggleBtnPicker = document.getElementById('btn-live-mode-picker') as HTMLButtonElement | null;
const liveModeStatusElPicker = document.getElementById('live-mode-status-picker') as HTMLSpanElement | null;

// Form elements
const inputId = requiredEl<HTMLInputElement>('input-id');
const inputName = requiredEl<HTMLInputElement>('input-name');
const inputScheme = requiredEl<HTMLSelectElement>('input-scheme');
const inputHost = requiredEl<HTMLInputElement>('input-host');
const inputPort = requiredEl<HTMLInputElement>('input-port');
const inputToken = requiredEl<HTMLInputElement>('input-token');

function shouldUseEmbeddedFrame(url: string): boolean {
  if (!webFrame || !webContainer) {
    return false;
  }

  try {
    const target = new URL(url);
    const shellHost = window.location.hostname.toLowerCase();

    // Cross-host iframe puts remote cookie in a third-party context. That can break
    // auth + ws stability ("Connection lost") for remote hosts like tidepool:3141.
    if (target.hostname.toLowerCase() !== shellHost) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// AppView implementation — bridges AppLifecycle to the DOM
const appView: AppView = {
  showWebContainer(url: string): void {
    if (shouldUseEmbeddedFrame(url) && webFrame && webContainer) {
      webFrame.src = url;
      webContainer.style.display = 'block';
      return;
    }

    // Remote-host mode: navigate top-level so auth cookie is first-party.
    window.location.href = url;
  },
  hideWebContainer(): void {
    if (!webFrame || !webContainer) {
      return;
    }

    webFrame.src = 'about:blank';
    webContainer.style.display = 'none';
  },
  showError(message: string): void {
    alert(message);
  },
  async refreshProfiles(): Promise<void> {
    await loadProfiles();
  }
};

const lifecycle = new AppLifecycle(profileRepo, coordinator, appView, liveModeController);
const sessionMonitor = new SessionMonitor(lifecycle, profileRepo);

async function loadProfiles() {
  try {
    currentProfiles = await profileRepo.getProfiles();
  } catch (e: any) {
    console.error('Failed to load profiles', e);
    currentProfiles = [];
  }

  renderProfiles();
}

function renderProfiles() {
  listEl.innerHTML = '';

  if (currentProfiles.length === 0) {
    listEl.innerHTML = '<p class="profile-empty">No profiles found. Add one to get started.</p>';
    selectedProfileId = null;
    updateLaunchButton();
    return;
  }

  currentProfiles.forEach(profile => {
    const card = document.createElement('div');
    card.className = `profile-card ${profile.id === selectedProfileId ? 'selected' : ''}`;
    card.onclick = () => {
      selectedProfileId = profile.id;
      renderProfiles();
      updateLaunchButton();
    };

    const info = document.createElement('div');
    info.className = 'profile-info';
    const badgeClass = profile.scheme === 'https' ? 'scheme-badge scheme-badge--https' : 'scheme-badge scheme-badge--http';
    const badgeText = profile.scheme === 'https' ? 'HTTPS' : 'HTTP';
    info.innerHTML = `
      <h3>${profile.name} <span class="${badgeClass}">${badgeText}</span></h3>
      <p>${profile.scheme}://${profile.host}:${profile.port}</p>
    `;

    const actions = document.createElement('div');
    actions.className = 'profile-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-ghost profile-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.onclick = (e) => {
      e.stopPropagation();
      openModal(profile);
    };

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger profile-action-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      if (confirm(`Delete profile ${profile.name}?`)) {
        await profileRepo.deleteProfile(profile.id);
        await tokenStore.deleteToken(profile.id);
        if (selectedProfileId === profile.id) {
          selectedProfileId = null;
        }
        await loadProfiles();
      }
    };

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(info);
    card.appendChild(actions);
    listEl.appendChild(card);
  });

  updateLaunchButton();
}

function updateLaunchButton() {
  const selectedExists =
    !!selectedProfileId && currentProfiles.some((p) => p.id === selectedProfileId);
  launchBtn.disabled = !selectedExists;
}

function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

async function openModal(profile?: Profile) {
  if (profile) {
    modalTitleEl.textContent = 'Edit Profile';
    inputId.value = profile.id;
    inputName.value = profile.name;
    inputScheme.value = profile.scheme;
    inputHost.value = profile.host;
    inputPort.value = profile.port.toString();

    // Fetch token (fail-closed: if it fails, keep empty)
    const token = await tokenStore.getToken(profile.id);
    inputToken.value = token || '';
  } else {
    modalTitleEl.textContent = 'Add Profile';
    inputId.value = generateId();
    inputName.value = '';
    inputScheme.value = 'http';
    inputHost.value = '';
    inputPort.value = '8080';
    inputToken.value = '';
  }

  modalEl.style.display = 'flex';
}

function closeModal() {
  modalEl.style.display = 'none';
}

async function saveProfile() {
  const profile: Profile = {
    id: inputId.value,
    name: inputName.value,
    scheme: inputScheme.value as 'http' | 'https',
    host: inputHost.value,
    port: parseInt(inputPort.value, 10) || 0
  };

  const token = inputToken.value.trim();

  try {
    // Token is optional. If provided, store securely.
    // If blank, remove any existing token so this profile uses direct/no-token mode.
    if (token) {
      await tokenStore.setToken(profile.id, token);
    } else {
      await tokenStore.deleteToken(profile.id);
    }

    // Save non-secret metadata
    await profileRepo.saveProfile(profile);

    closeModal();
    selectedProfileId = profile.id;
    await loadProfiles();
  } catch (e: any) {
    alert(`Failed to save profile: ${e.message}`);
  }
}

async function handleLaunchBtnClick() {
  if (!selectedProfileId) return;

  const profile = currentProfiles.find(p => p.id === selectedProfileId);
  if (profile) {
    const policy = evaluateHttpPolicy(profile);
    if (policy.requiresConfirm && !confirm(policy.warningMessage)) {
      return;
    }
  }

  await lifecycle.connect(selectedProfileId);
}

async function handleSwitchProfile() {
  await lifecycle.switchProfile();
}

/** Update Live Mode UI label and button text from current state. */
function updateLiveModeUI(): void {
  const state = liveModeController.getState();
  const labels: Record<string, string> = {
    idle: 'Idle',
    starting: 'Starting...',
    live: 'Live',
    stopping: 'Stopping...',
  };

  const statusEls = [liveModeStatusEl, liveModeStatusElPicker].filter(Boolean) as HTMLSpanElement[];
  const toggleBtns = [liveModeToggleBtn, liveModeToggleBtnPicker].filter(Boolean) as HTMLButtonElement[];

  for (const el of statusEls) {
    el.textContent = labels[state] ?? state;
    el.className = `live-mode-status live-mode-status--${state}`;
  }

  for (const btn of toggleBtns) {
    btn.textContent = state === 'live' || state === 'starting' ? 'Stop Live' : 'Go Live';
    btn.disabled = state === 'starting' || state === 'stopping';
  }
}

async function handleLiveModeToggle(): Promise<void> {
  try {
    await liveModeController.toggle();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to toggle Live Mode';
    console.error('[rho-android] Live Mode toggle error:', msg);
  }
}

/**
 * App visibility lifecycle — capture replay snapshot on background,
 * restore it on foreground return.
 */
function setupAppLifecycle(): void {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      // App going to background: capture replay state from active frame.
      const frame = webFrame ?? null;
      if (frame && lifecycle.getActiveProfileId()) {
        const snapshot = await replayResume.captureSnapshot(frame);
        replayResume.saveSnapshot(snapshot);
      }
    } else if (document.visibilityState === 'visible') {
      // App returning to foreground: restore replay state if available.
      const snapshot = replayResume.loadSnapshot();
      if (snapshot && lifecycle.getActiveProfileId()) {
        const frame = webFrame ?? null;
        if (frame) {
          replayResume.emitResumeRequest(frame, snapshot);
        }
      }
    }
  });
}

// Bind events
addBtn.addEventListener('click', () => openModal());
cancelBtn.addEventListener('click', closeModal);
saveBtn.addEventListener('click', saveProfile);
launchBtn.addEventListener('click', handleLaunchBtnClick);
if (switchProfileBtn) {
  switchProfileBtn.addEventListener('click', handleSwitchProfile);
} else {
  console.warn('[rho-android] #btn-switch-profile not found; profile picker remains functional.');
}
if (liveModeToggleBtn) {
  liveModeToggleBtn.addEventListener('click', handleLiveModeToggle);
}
if (liveModeToggleBtnPicker) {
  liveModeToggleBtnPicker.addEventListener('click', handleLiveModeToggle);
}

// Live Mode state → UI
liveModeController.addListener(() => updateLiveModeUI());

// Listen for explicit auth failure signals from the web container if it implements postMessage
window.addEventListener('message', async (event) => {
  if (event.data && event.data.type === 'AUTH_FAILURE') {
    await lifecycle.handleAuthFailure(event.data.reason || 'unknown');
  }
});

function isPickerModeRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('picker') === '1';
  } catch {
    return false;
  }
}

// Initialize — auto-connect last used profile on startup unless picker mode is requested.
// Start session monitor after successful initial load.
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Mount replay resume listener (must be before any frame loads).
    replayResume.mount();

    // Initialize Live Mode controller: restores persisted preference + native state.
    await liveModeController.initialize();
    updateLiveModeUI();

    // Wire app visibility lifecycle for snapshot capture/restore.
    setupAppLifecycle();

    await loadProfiles();

    if (isPickerModeRequested()) {
      await profileRepo.setLastUsedProfileId(null);
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState({}, '', window.location.pathname);
      }
    } else {
      await lifecycle.onStartup();
    }

    sessionMonitor.start();
  } catch (e: any) {
    console.error('Failed to initialize rho-android shell', e);
    alert(`Failed to initialize app shell: ${e?.message ?? 'unknown error'}`);
  }
});
