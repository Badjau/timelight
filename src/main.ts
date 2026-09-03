import { registerSW } from 'virtual:pwa-register';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('TimeLight app root was not found.');
}

app.innerHTML = `
  <div class="page-shell">
    <header class="topbar">
      <a class="brand" href="/timelight/" aria-label="TimeLight home">
        <span class="brand-mark" aria-hidden="true">
          <span class="lamp lamp-blue"></span>
          <span class="lamp lamp-yellow"></span>
          <span class="lamp lamp-red"></span>
        </span>
        <span>TimeLight</span>
      </a>
      <span class="version">v${__APP_VERSION__}</span>
    </header>

    <section class="hero" aria-labelledby="welcome-title">
      <div class="eyebrow"><span class="pulse" aria-hidden="true"></span> Ready for the next moment</div>
      <h1 id="welcome-title">Keep every moment<br /><em>in view.</em></h1>
      <p class="intro">A calm, clear timing interface for speeches, presentations, debates, and events.</p>
      <div class="status-card" role="status" aria-live="polite">
        <span class="status-dot" aria-hidden="true"></span>
        <span id="connection-status">Checking connection…</span>
      </div>
    </section>

    <section class="stage-preview" aria-label="Timing stage preview">
      <div class="stage-header">
        <span>Stage preview</span>
        <span class="stage-note">Hardware connection coming next</span>
      </div>
      <div class="stage-lights" aria-hidden="true">
        <span class="preview-light preview-blue"></span>
        <span class="preview-light preview-yellow"></span>
        <span class="preview-light preview-orange"></span>
        <span class="preview-light preview-red"></span>
      </div>
      <div class="stage-footer">
        <span>Start</span>
        <span>Approaching</span>
        <span>Nearing limit</span>
        <span>Time reached</span>
      </div>
    </section>

    <footer class="footer">Designed to stay useful when the network does not.</footer>
  </div>
`;

const connectionStatus = document.querySelector<HTMLSpanElement>('#connection-status');
const statusDot = document.querySelector<HTMLSpanElement>('.status-dot');

function updateConnectionStatus(): void {
  const online = navigator.onLine;
  if (connectionStatus) {
    connectionStatus.textContent = online ? 'Online · Application shell is ready' : 'Offline · Running from the cached shell';
  }
  statusDot?.classList.toggle('offline', !online);
}

window.addEventListener('online', updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);
updateConnectionStatus();

registerSW({
  immediate: true,
  onOfflineReady() {
    updateConnectionStatus();
  },
  onNeedRefresh() {
    // Leave the new worker waiting. It will activate naturally once every
    // TimeLight window is closed, so an open application is never reloaded.
    document.body.dataset.updateWaiting = 'true';
  },
});
