import { createRequire } from 'module';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';
import config from '../config/config.js';
import aiService from './ai.js';
import catchupService from './catchup.js';

const { Client, LocalAuth, MessageMedia } = pkg;
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

/**
 * whatsapp-web.js defaults to claiming "Chrome/101 on macOS 10.14" (a 2022 browser) while
 * Puppeteer really runs a current Chrome on Linux — whose client-hint headers and JS report
 * the real version. That self-contradicting fingerprint is an easy automation tell, and was
 * live on production (Chrome 146 claiming 101) when the phone started refusing to link
 * ("Couldn't link device. Try again later."). Report the real major version and host OS.
 * Returns undefined (library default) if the Chrome version can't be determined.
 */
function realChromeUserAgent() {
  if (config.whatsappWeb.userAgent) return config.whatsappWeb.userAgent;
  let major = null;
  try {
    major = String(require('puppeteer').PUPPETEER_REVISIONS.chrome).split('.')[0];
  } catch {
    return undefined;
  }
  if (!/^\d+$/.test(major)) return undefined;
  const os = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : 'X11; Linux x86_64';
  // Chrome's reduced UA format: only the major version is real, the rest is always 0.0.0.
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Close a client's browser, ignoring every error — it may never have launched, or be gone. */
async function closeQuietly(client) {
  try {
    await client.destroy();
  } catch {
    /* best-effort */
  }
}

/** Resolves to `fallback` if `promise` hasn't settled within `ms`. Never rejects. */
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(r => { timer = setTimeout(() => r(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Kill a Chrome and everything it spawned. Puppeteer launches it detached, so pid = group id. */
function killBrowserTree(pid) {
  if (!pid || process.platform === 'win32') return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Close a client for good. destroy() alone can hang forever on a wedged browser — and the
 * 'disconnected' handler awaited exactly that, so a hung Chrome left the bot silent with no
 * re-init ever scheduled. Give it 20s, then kill the process tree regardless.
 */
async function teardown(client) {
  if (!client) return;
  const pid = client.pupBrowser?.process?.()?.pid;
  await withTimeout(closeQuietly(client), 20000);
  if (pid) killBrowserTree(pid);
}

/** CPU seconds used so far by a process and all its descendants, from /proc. Linux only. */
async function treeCpuSeconds(rootPid) {
  const entries = await fs.readdir('/proc');
  const stats = new Map();
  await Promise.all(entries.filter(e => /^\d+$/.test(e)).map(async (pid) => {
    try {
      const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      // The command name is in parentheses and may contain spaces; fields resume after ')'.
      const f = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      stats.set(Number(pid), { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]) });
    } catch { /* exited mid-scan */ }
  }));
  let ticks = 0;
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    ticks += stats.get(pid)?.ticks || 0;
    for (const [child, s] of stats) if (s.ppid === pid) queue.push(child);
  }
  return ticks / 100; // USER_HZ is 100 on every mainstream Linux build
}

/** The Chrome profile folder LocalAuth gives this client — the thing Chrome locks. */
function sessionDirFor(client) {
  return client?.authStrategy?.userDataDir
    || path.resolve('./.wwebjs_auth/', `session-${config.whatsappWeb.clientId}`);
}

/**
 * Free a session folder that a leftover Chrome is still holding.
 *
 * Chrome allows one browser per profile folder. If a previous browser for this folder is
 * still alive — leaked by a client torn down mid-launch, or orphaned when an earlier run of
 * the bot died — every new launch fails with "The browser is already running for …", forever.
 *
 * Kills the leftover only when it is provably ours to kill: its parent is THIS process (a
 * leaked client of ours) or init (its bot process is dead). A browser whose parent is some
 * other live process belongs to a second copy of the bot — killing it would just start a
 * tug-of-war over the session — so that case is reported, not "fixed".
 */
async function releaseStaleBrowser(dir) {
  if (process.platform === 'win32') {
    console.warn(`[WhatsApp Web Bot] Session folder is locked by another Chrome: ${dir}. Close it (Task Manager → chrome.exe) and the bot will retry.`);
    return;
  }
  let rows;
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 16 * 1024 * 1024 });
    rows = stdout.split('\n').map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] } : null;
    }).filter(Boolean);
  } catch (err) {
    console.warn('[WhatsApp Web Bot] Could not list processes to free the session folder:', err.message);
    return;
  }

  // The browser's main process: carries our profile folder and, unlike its renderer/GPU/
  // utility children, no --type= switch. Killing its process group takes the children too.
  const owners = rows.filter(r => r.args.includes(`--user-data-dir=${dir}`) && !r.args.includes('--type='));
  if (!owners.length) {
    console.warn(`[WhatsApp Web Bot] Session folder reported locked but no browser holds it: ${dir}`);
  }
  for (const owner of owners) {
    const parent = rows.find(r => r.pid === owner.ppid);
    // Orphans are reparented to init — or to a subreaper on some hosts, so "any non-node
    // parent" rather than strictly PID 1.
    const ours = owner.ppid === process.pid || !parent || !/\bnode\b/.test(parent.args);
    if (!ours) {
      console.error(`[WhatsApp Web Bot] The session is held by Chrome PID ${owner.pid}, started by another process (PID ${owner.ppid}: ${parent.args.slice(0, 120)}). ` +
        'Two copies of the bot are running against one WhatsApp session — stop the duplicate (`pm2 list`, `ps aux | grep node`).');
      continue;
    }
    console.warn(`[WhatsApp Web Bot] Killing leftover Chrome PID ${owner.pid} that was holding the session folder.`);
    killBrowserTree(owner.pid);
  }

  // Chrome clears a stale lock itself once its owner is dead; removing it is belt-and-braces.
  await new Promise(r => setTimeout(r, 1000));
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
  }
}

class WhatsAppWebBot {
  constructor() {
    this.status = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, CODE_READY, CONNECTED
    this.qrDataUrl = null;
    this.client = null;
    // Which WhatsApp account is currently linked — captured on 'ready' and surfaced in the
    // admin console. Without this, nobody can tell WHOSE phone the bot is paired to without
    // physically checking every candidate device's "Linked devices" screen.
    this.deviceInfo = null;
    this.connectedAt = null;
    // Single pending re-init timer. Both the 'disconnected' handler and logout() want to
    // bring the client back up; if each sets its own setTimeout we end up launching TWO
    // Puppeteer/WhatsApp clients against one LocalAuth session, which corrupts it.
    this.reinitTimer = null;
    this.loggingOut = false;
    // Self-healing watchdog — see watchdogTick().
    this.watchdogTimer = null;
    this.watchdogFailures = 0;
    this.connectingSince = null;
    this.cpuSample = null;      // { pid, cpuSeconds, at } from the previous tick
    this.cpuHotTicks = 0;       // consecutive ticks over cpuLimitPercent
    this.recovering = false;
    // Phone-number linking (the phone's "Link with phone number instead"). When pairingPhone
    // is set, the next client is built with `pairWithPhoneNumber`, which makes WhatsApp Web
    // hand out an 8-character code instead of a QR. It has to be a fresh client: the library
    // decides QR vs code once, during initialize().
    this.pairingPhone = null;
    this.pairingCode = null;
    this.pairingCodeAt = null;
    // Per-sender processing chains: a global concurrency-N pool (the old approach)
    // can dequeue two messages from the SAME customer onto different workers at once,
    // and since answerQuery does a read-modify-write on that customer's session, the
    // two calls race and one update silently disappears (e.g. "size M" then "qty 3"
    // sent seconds apart — one of them gets lost). Chaining per senderId guarantees
    // strict in-order processing for a given customer while different customers still
    // run fully in parallel.
    this.senderChains = new Map();
    // whatsapp-web.js occasionally re-emits the same inbound message (reconnects,
    // session resync) with no dedupe of its own — without this, a replayed 'message'
    // event runs the full agent + LLM call twice and sends two near-identical replies
    // for what the customer only sent once. Capped FIFO so it can't grow unbounded
    // in a long-running process.
    this.seenMessageIds = new Set();
    // --- Outbound send pacing (ban-risk protection) ---
    // WhatsApp rate-limits and bans per ACCOUNT, not per chat, so pacing has to be
    // global across every customer AND every owner alert. sendChain serialises all
    // outbound sends into one queue; each one takes its turn and only then checks the
    // clock. (Checking the clock in parallel is the classic mistake — N callers all
    // read the same "last send" timestamp, all wait the same amount, then all fire
    // together, which is no rate limit at all.)
    this.sendChain = Promise.resolve();
    this.lastSendAt = 0;
    // Rolling 60s window of send timestamps, for the per-minute ceiling.
    this.sendWindow = [];
    // Rolling 60-MINUTE window of { at, chat }, for the distinct-chats-per-hour ceiling.
    // The per-minute cap cannot see a slow, steady broadcast: 8/min is also 480/hour, and
    // 480 different people contacted by one handset in an hour is a bulk campaign however
    // politely it is spaced. This window is what the bulk paths (catch-up drip, cold-lead
    // follow-ups) check before deciding to send.
    this.chatWindow = [];
  }

  /**
   * How many DISTINCT chats this account has messaged in the last hour, and whether there is
   * room for one more under `maxNewChatsPerHour`.
   *
   * Deliberately a question the caller asks rather than a wait inside awaitSendSlot(). The
   * send chain is global, so blocking in there to enforce an HOURLY budget would park a live
   * customer's reply behind the backlog for up to an hour — trading a ban risk for the exact
   * failure (unanswered customers) the catch-up feature exists to prevent. Bulk senders can
   * afford to wait for the next tick; a real customer mid-conversation cannot.
   */
  chatBudget() {
    const cutoff = Date.now() - 3600 * 1000;
    this.chatWindow = this.chatWindow.filter(e => e.at > cutoff);
    const used = new Set(this.chatWindow.map(e => e.chat)).size;
    const max = config.whatsappWeb.maxNewChatsPerHour;
    return { used, max, hasRoom: max <= 0 || used < max };
  }

  /**
   * The ONLY place that may call client.sendMessage. Serialises every outbound message
   * behind a single global queue and paces it (min gap + jitter + per-minute ceiling)
   * so a 100-customer burst goes out at a human rate instead of all at once.
   *
   * Returns the underlying sendMessage promise, so callers can still await/catch it.
   * A failed send never breaks the queue for the messages behind it.
   */
  sendText(to, content, options = undefined) {
    const run = this.sendChain.then(async () => {
      if (!this.client) throw new Error('WhatsApp client not initialised');
      await this.awaitSendSlot(to);
      return options ? this.client.sendMessage(to, content, options)
                     : this.client.sendMessage(to, content);
    });
    // Swallow this send's outcome for chain-continuation purposes only — the caller
    // still sees the real result/rejection via `run`.
    this.sendChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Blocks until it's safe to send the next message. Called only from inside the
   * serialised sendChain, so the timestamps it reads and writes can't race.
   */
  async awaitSendSlot(to) {
    const cfg = config.whatsappWeb;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // 1) Rolling per-minute ceiling.
    const maxPerMin = cfg.maxSendsPerMinute;
    if (maxPerMin > 0) {
      this.sendWindow = this.sendWindow.filter(t => Date.now() - t < 60000);
      if (this.sendWindow.length >= maxPerMin) {
        const waitMs = 60000 - (Date.now() - this.sendWindow[0]) + 50;
        if (waitMs > 0) {
          console.log(`[WhatsApp] Send cap reached (${maxPerMin}/min) — holding ${Math.round(waitMs / 1000)}s.`);
          await sleep(waitMs);
          this.sendWindow = this.sendWindow.filter(t => Date.now() - t < 60000);
        }
      }
    }

    // 2) Minimum gap since the previous send, plus jitter so the cadence isn't robotic.
    const gap = cfg.minSendGapMs + Math.floor(Math.random() * (cfg.sendJitterMs || 0));
    const sinceLast = Date.now() - this.lastSendAt;
    if (this.lastSendAt && sinceLast < gap) {
      await sleep(gap - sinceLast);
    }

    this.lastSendAt = Date.now();
    this.sendWindow.push(this.lastSendAt);
    if (to) {
      this.chatWindow.push({ at: this.lastSendAt, chat: to });
      if (this.chatWindow.length > 5000) this.chatWindow.splice(0, this.chatWindow.length - 5000);
    }
  }

  /**
   * Holds a reply back so the total time from "customer sent" to "bot replied" never
   * looks inhumanly fast. Deterministic fast paths (FAQ, knowledge, size parsing) answer
   * in single-digit milliseconds — instant replies to everyone, around the clock, is one
   * of the clearest automation tells. Replies that already took longer than the target
   * (any LLM call) are sent immediately with no added delay, so this costs real customers
   * nothing on the slow paths.
   */
  async humanizeDelay(receivedAt, replyText = '') {
    const cfg = config.whatsappWeb;
    const lengthBonus = Math.min(
      (replyText || '').length * (cfg.replyDelayPerCharMs || 0),
      Math.max(cfg.maxReplyDelayMs - cfg.minReplyDelayMs, 0)
    );
    const target = cfg.minReplyDelayMs + lengthBonus + Math.floor(Math.random() * 400);
    const elapsed = Date.now() - receivedAt;
    if (elapsed < target) {
      await new Promise(r => setTimeout(r, target - elapsed));
    }
  }

  isDuplicateMessage(msg) {
    const msgId = msg.id?._serialized || msg.id?.id;
    if (!msgId) return false;
    if (this.seenMessageIds.has(msgId)) return true;
    this.seenMessageIds.add(msgId);
    if (this.seenMessageIds.size > 1000) {
      const oldest = this.seenMessageIds.values().next().value;
      this.seenMessageIds.delete(oldest);
    }
    return false;
  }

  enqueueMessage(msg) {
    const senderId = msg.from;
    const previous = this.senderChains.get(senderId) || Promise.resolve();
    const chain = previous
      .then(() => this.handleIncomingMessage(msg))
      .catch(err => console.error(`[Queue] Unhandled error processing message from ${senderId}:`, err.message))
      .finally(() => {
        if (this.senderChains.get(senderId) === chain) {
          this.senderChains.delete(senderId);
        }
      });
    this.senderChains.set(senderId, chain);
  }

  /**
   * Read the linked account off `client.info` into `deviceInfo`.
   *
   * Called on 'ready' AND lazily from getStatus(), because `client.info` is not reliably
   * populated at the moment 'ready' fires — observed in production 2026-08-05, where the
   * console showed a healthy CONNECTED session with "Unknown number"/"Linked since Never"
   * while the same build filled it in correctly locally. The server resolves LIDs
   * (`…@lid`) rather than plain phone JIDs, and `info` lands slightly later there. Reading
   * it again when the admin page polls costs nothing and closes that window.
   *
   * Returns the captured object, or null if there's still nothing to read.
   */
  captureDeviceInfo(source = 'lazy') {
    try {
      const info = this.client?.info;
      if (!info) return null;
      // The shape has moved between whatsapp-web.js versions — `me` is the older field.
      const wid = info.wid || info.me || {};
      const number = wid.user || wid._serialized?.split('@')[0] || null;
      if (!number && !info.pushname) return null;
      this.deviceInfo = {
        number,
        name: info.pushname || null,
        platform: info.platform || null,
        connectedAt: this.connectedAt || new Date().toISOString(),
      };
      if (source === 'ready') {
        console.log(`[WhatsApp Web Bot] Linked account: +${number || '?'}${info.pushname ? ` (${info.pushname})` : ''}`);
      }
      return this.deviceInfo;
    } catch (err) {
      console.warn('[WhatsApp Web Bot] Could not read linked-account info:', err.message);
      return null;
    }
  }

  /**
   * Queue a re-initialization, replacing any already-pending one. Every path that wants the
   * client back (disconnect, auth failure, launch failure, admin logout) MUST go through
   * here rather than calling setTimeout(initialize) directly — see reinitTimer above.
   */
  scheduleReinit(delayMs) {
    if (this.reinitTimer) clearTimeout(this.reinitTimer);
    this.reinitTimer = setTimeout(() => {
      this.reinitTimer = null;
      this.initialize();
    }, delayMs);
  }

  startWatchdog() {
    if (this.watchdogTimer || !(config.whatsappWeb.watchdogIntervalMs > 0)) return;
    this.watchdogTimer = setInterval(() => {
      this.watchdogTick().catch(err => console.error('[WhatsApp Watchdog] Check failed:', err.message));
    }, config.whatsappWeb.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }

  /**
   * Keeps the bot answering 24/7 without anyone watching it.
   *
   * The linked phone is not what fails — a linked device stays linked for as long as the
   * phone comes online every couple of weeks. What fails is the headless Chrome on the
   * server, in three ways the library never reports:
   *   - it hangs (the page stops answering; status still says CONNECTED, nothing is replied to)
   *   - a launch never finishes (the library loads WhatsApp Web with no timeout)
   *   - it spins a core at 100% — which got the VPS CPU-throttled by Hostinger on 2026-09-28,
   *     making everything slower still
   * Each is recovered by restarting the browser from the saved session: no QR, no re-link,
   * and the catch-up sweep on 'ready' answers anyone who wrote in the meantime.
   *
   * QR_READY / CODE_READY are left alone: they are waiting for a human, not stuck.
   */
  async watchdogTick() {
    const cfg = config.whatsappWeb;
    const client = this.client;
    if (!client || this.recovering || this.loggingOut) return;

    if (this.status === 'CONNECTING') {
      if (this.connectingSince && Date.now() - this.connectingSince > cfg.launchTimeoutMs) {
        await this.recover(`still starting after ${Math.round(cfg.launchTimeoutMs / 1000)}s`);
      }
      return;
    }
    if (this.status !== 'CONNECTED') return;

    const state = await withTimeout(client.getState(), 20000, 'NO_RESPONSE');
    if (this.client !== client) return;
    if (state === 'CONNECTED') {
      this.watchdogFailures = 0;
    } else {
      this.watchdogFailures += 1;
      console.warn(`[WhatsApp Watchdog] WhatsApp state is ${state} (${this.watchdogFailures}/${cfg.watchdogMaxFailures}).`);
      if (this.watchdogFailures >= cfg.watchdogMaxFailures) {
        await this.recover(`state ${state} for ${this.watchdogFailures} checks in a row`);
        return;
      }
    }

    await this.checkBrowserCpu(client);
  }

  async checkBrowserCpu(client) {
    const cfg = config.whatsappWeb;
    if (process.platform !== 'linux' || !(cfg.cpuLimitPercent > 0)) return;
    const pid = client.pupBrowser?.process?.()?.pid;
    if (!pid) return;
    const cpuSeconds = await treeCpuSeconds(pid).catch(() => null);
    if (cpuSeconds == null) return;
    const now = Date.now();
    const prev = this.cpuSample;
    this.cpuSample = { pid, cpuSeconds, at: now };
    if (!prev || prev.pid !== pid) return;

    const percent = ((cpuSeconds - prev.cpuSeconds) / ((now - prev.at) / 1000)) * 100;
    if (percent < cfg.cpuLimitPercent) {
      this.cpuHotTicks = 0;
      return;
    }
    this.cpuHotTicks += 1;
    const hotMs = this.cpuHotTicks * cfg.watchdogIntervalMs;
    console.warn(`[WhatsApp Watchdog] Chrome at ${Math.round(percent)}% CPU (${Math.round(hotMs / 60000)} min so far).`);
    if (hotMs >= cfg.cpuLimitMinutes * 60000) {
      await this.recover(`Chrome at ${Math.round(percent)}% CPU for ${cfg.cpuLimitMinutes} min`);
    }
  }

  /** Throw the current browser away and start a new one from the saved session. */
  async recover(reason) {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const client = this.client;
      console.warn(`[WhatsApp Watchdog] Restarting WhatsApp browser: ${reason}. The linked session is kept — no re-link needed.`);
      this.client = null;
      this.status = 'DISCONNECTED';
      this.qrDataUrl = null;
      this.deviceInfo = null;
      this.connectedAt = null;
      await teardown(client);
      this.scheduleReinit(3000);
    } finally {
      this.recovering = false;
    }
  }

  /**
   * Unlink the currently paired phone and come back up with a fresh QR.
   *
   * client.logout() revokes the session on the phone's side AND clears the LocalAuth folder,
   * which is the difference that matters: destroy() alone would just close the browser and
   * the next initialize() would silently re-pair the SAME number, so "logout" wouldn't log
   * anything out. The client reference is detached first so the 'disconnected' event this
   * triggers can't double-destroy or double-schedule behind us.
   */
  async logout() {
    if (!config.whatsappWeb.enabled) {
      return { ok: false, message: 'WhatsApp Web integration is disabled.' };
    }
    if (this.loggingOut) {
      return { ok: false, message: 'A logout is already in progress.' };
    }
    const client = this.client;
    if (!client) {
      return { ok: false, message: 'No active WhatsApp session to log out.' };
    }

    this.loggingOut = true;
    const previous = this.deviceInfo?.number || null;
    this.clearPairing();
    // Detach first: the 'disconnected' handler checks `this.client` and will now no-op.
    this.client = null;
    this.status = 'DISCONNECTED';
    this.qrDataUrl = null;
    this.deviceInfo = null;
    this.connectedAt = null;

    let cleared = true;
    try {
      await client.logout();
      console.log(`[WhatsApp Web Bot] Logged out${previous ? ` (was +${previous})` : ''}. Session cleared.`);
    } catch (err) {
      // logout() can throw if the page is already gone. The session files may then survive,
      // so say so honestly rather than reporting a clean unlink that didn't happen.
      cleared = false;
      console.warn('[WhatsApp Web Bot] logout() failed:', err.message);
    }
    await teardown(client);

    this.loggingOut = false;
    // Short delay (not the 10s reconnect one) so the admin gets a new QR promptly.
    this.scheduleReinit(2000);
    return {
      ok: true,
      cleared,
      previousNumber: previous,
      message: cleared
        ? 'Logged out. A new QR code will appear in a few seconds.'
        : 'Session closed, but the stored login may not have been fully cleared — if the same number reconnects, delete apps/bot/.wwebjs_auth and restart.',
    };
  }

  clearPairing() {
    this.pairingPhone = null;
    this.pairingCode = null;
    this.pairingCodeAt = null;
  }

  /**
   * Tear down the current (unpaired) client and bring a new one up — used to switch between
   * QR linking and phone-number linking. Only allowed while nothing is linked, so it can
   * never drop a live customer session.
   */
  async restartForLinking() {
    const client = this.client;
    this.client = null;
    this.status = 'CONNECTING';
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.pairingCodeAt = null;
    await teardown(client);
    this.scheduleReinit(1000);
  }

  /**
   * Switch to phone-number linking. Accepts the number with or without +, spaces or dashes;
   * a bare 10-digit number is treated as Indian (+91), since that's this store's market.
   */
  async startPhonePairing(rawPhone) {
    if (!config.whatsappWeb.enabled) {
      return { ok: false, message: 'WhatsApp Web integration is disabled.' };
    }
    if (this.status === 'CONNECTED') {
      return { ok: false, message: 'A number is already linked. Log it out first.' };
    }
    if (this.loggingOut) {
      return { ok: false, message: 'A logout is in progress — try again in a few seconds.' };
    }
    let digits = String(rawPhone || '').replace(/\D/g, '');
    if (digits.length === 10) digits = '91' + digits;
    if (digits.length < 11 || digits.length > 15) {
      return { ok: false, message: 'Enter the full WhatsApp number with country code, e.g. +91 98765 43210.' };
    }

    console.log(`[WhatsApp Web Bot] Switching to phone-number linking for +${digits}.`);
    this.pairingPhone = digits;
    await this.restartForLinking();
    return { ok: true, phoneNumber: digits, message: 'Generating a linking code — it will appear in a few seconds.' };
  }

  async cancelPhonePairing() {
    if (this.status === 'CONNECTED') {
      return { ok: false, message: 'A number is already linked.' };
    }
    if (!this.pairingPhone) {
      return { ok: true, message: 'Already in QR mode.' };
    }
    console.log('[WhatsApp Web Bot] Phone-number linking cancelled — back to QR.');
    this.clearPairing();
    await this.restartForLinking();
    return { ok: true, message: 'Back to QR code — a new one will appear in a few seconds.' };
  }

  initialize() {
    if (!config.whatsappWeb.enabled) {
      console.log('[WhatsApp Web Bot] Disabled in config. Skipping initialization.');
      return;
    }

    if (this.client) {
      console.log('[WhatsApp Web Bot] Client already exists. Skipping duplicate initialization.');
      return;
    }

    console.log('[WhatsApp Web Bot] Initializing client...');
    this.status = 'CONNECTING';
    this.connectingSince = Date.now();
    this.watchdogFailures = 0;
    this.cpuSample = null;
    this.cpuHotTicks = 0;
    this.startWatchdog();

    try {
      const userAgent = realChromeUserAgent();
      if (userAgent) console.log(`[WhatsApp Web Bot] User agent: ${userAgent}`);
      const client = new Client({
        ...(userAgent ? { userAgent } : {}),
        authStrategy: new LocalAuth({
          // Which folder under .wwebjs_auth/ holds the session. Overridable so a developer
          // can run locally against a throwaway number (WHATSAPP_CLIENT_ID=local-test)
          // without restoring — or corrupting — the paired shop session. Two machines
          // sharing one LocalAuth folder is the same hazard as two clients sharing one, and
          // recovering from it means re-linking the live number.
          clientId: config.whatsappWeb.clientId
        }),
        ...(this.pairingPhone ? {
          pairWithPhoneNumber: {
            phoneNumber: this.pairingPhone,
            showNotification: true,
            // WhatsApp expires a code after a few minutes; the library re-requests on this interval.
            intervalMs: 180000,
          },
        } : {}),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-features=NetworkService'
          ]
        }
      });
      this.client = client;

      this.client.on('qr', async (qr) => {
        // A client being torn down for a QR ↔ phone-number switch can still emit late.
        if (this.client !== client) return;
        console.log('[WhatsApp Web Bot] QR code received. Generating data URL...');
        this.status = 'QR_READY';
        try {
          this.qrDataUrl = await qrcode.toDataURL(qr);
        } catch (err) {
          console.error('[WhatsApp Web Bot] Failed to generate QR data URL:', err.message);
        }
      });

      this.client.on('code', (code) => {
        if (this.client !== client) return;
        console.log(`[WhatsApp Web Bot] Linking code received for +${this.pairingPhone}.`);
        this.status = 'CODE_READY';
        this.qrDataUrl = null;
        this.pairingCode = code;
        this.pairingCodeAt = new Date().toISOString();
      });

      this.client.on('ready', () => {
        console.log('[WhatsApp Web Bot] Client is ready and connected!');
        this.status = 'CONNECTED';
        this.qrDataUrl = null;
        // Linked — later reconnects restore the saved session and must not ask for a code again.
        this.clearPairing();
        // Record the connect time here even if the account details aren't readable yet —
        // otherwise "Linked since" shows "Never" on a perfectly healthy connection.
        this.connectedAt = new Date().toISOString();
        this.captureDeviceInfo('ready');

        // Find everyone who messaged while we were away. whatsapp-web.js never fires
        // 'message' for those, so without this sweep they are silently never answered.
        // Delayed so the initial chat sync has settled — getChats() straight off 'ready'
        // can return a partial list, which would mean missing exactly the customers this
        // is meant to rescue. Deliberately not awaited: a slow sweep must not hold up
        // live message handling.
        catchupService.start(this);
        setTimeout(() => {
          catchupService.sweep().catch((err) =>
            console.error('[WhatsApp Web Bot] Catch-up sweep failed:', err.message));
        }, 15000);
      });

      this.client.on('authenticated', () => {
        console.log('[WhatsApp Web Bot] Authenticated successfully.');
      });

      this.client.on('auth_failure', async (msg) => {
        console.error('[WhatsApp Web Bot] Authentication failed:', msg);
        if (this.client !== client) return;
        this.status = 'DISCONNECTED';
        this.qrDataUrl = null;
        this.deviceInfo = null;
        this.connectedAt = null;
        this.client = null;
        await teardown(client);
        // Without this the bot sat dead after an auth failure until someone restarted it.
        // A fresh client shows a QR if the saved session really is gone.
        this.scheduleReinit(10000);
      });

      this.client.on('disconnected', async (reason) => {
        console.log('[WhatsApp Web Bot] Client disconnected:', reason);
        // logout() and restartForLinking() detach this.client before tearing it down and handle
        // their own re-init, so bail out rather than fighting them for the same client.
        if (this.client !== client) return;
        this.status = 'DISCONNECTED';
        this.qrDataUrl = null;
        this.deviceInfo = null;
        this.connectedAt = null;
        // Detach before tearing down, and never let a wedged browser block the re-init.
        this.client = null;
        await teardown(client);

        // Auto-reinitialize after 10 seconds
        this.scheduleReinit(10000);
      });

      this.client.on('message', async (msg) => {
        if (this.isDuplicateMessage(msg)) {
          console.log(`[WhatsApp] Duplicate 'message' event for id ${msg.id?._serialized || msg.id?.id} — skipping.`);
          return;
        }
        this.enqueueMessage(msg);
      });

      this.client.initialize().then(() => {
        // Superseded while launching (QR ↔ phone-number switch): restartForLinking()'s
        // destroy() ran before this client had a browser, so it closed nothing. Close it now,
        // or it keeps holding the session folder and every later launch fails.
        if (this.client !== client) {
          teardown(client);
          return;
        }
        // Chrome crashing or being killed fires no WhatsApp event at all — the bot would keep
        // reporting CONNECTED while answering nobody. Recover the moment the browser goes.
        client.pupBrowser?.on('disconnected', () => {
          if (this.client === client) this.recover('the browser closed unexpectedly');
        });
        client.pupPage?.on('error', (err) => {
          if (this.client === client) this.recover(`the WhatsApp page crashed (${err?.message || err})`);
        });
      }, async (error) => {
        // A launch can fail AFTER Chrome is up (page load, inject), and a superseded client's
        // launch rejects too. Either way its browser may still be running — always close it.
        await teardown(client);
        // That client is already replaced, so don't null out or re-init over the new one.
        if (this.client !== client) return;
        console.error('[WhatsApp Web Bot] Failed to initialize client asynchronously:', error.message);
        this.status = 'DISCONNECTED';
        this.client = null;
        this.deviceInfo = null;
        this.connectedAt = null;
        if (/already running/i.test(error.message || '')) {
          // A Chrome from an earlier client (or an earlier run of this process) still holds
          // the session folder. Retrying cannot help until it is gone — this looped every
          // 10s for hours on 2026-09-28 and blocked QR and phone-number linking alike.
          await releaseStaleBrowser(sessionDirFor(client));
        }
        // Auto-reinitialize after 10 seconds on failure
        this.scheduleReinit(10000);
      });
    } catch (error) {
      console.error('[WhatsApp Web Bot] Failed to initialize client:', error.message);
      this.status = 'DISCONNECTED';
      this.client = null;
    }
  }

  async handleIncomingMessage(msg) {
    let typingInterval = null;
    // When the customer's message landed — humanizeDelay() measures the reply turnaround
    // from here, so deterministic zero-latency answers don't go out instantly.
    const receivedAt = Date.now();
    try {
      // Ignore group chats, broadcast/status
      if (msg.isGroupMsg || msg.from.includes('@g.us') || msg.from === 'status@broadcast') {
        return;
      }

      // A message must have EITHER text or media. A photo of a damaged/wrong jersey
      // typically arrives with no caption (empty body) — previously that was dropped
      // silently, so the support flow never saw it. Accept media too.
      const hasMedia = !!msg.hasMedia;
      if (!msg.body && !hasMedia) return;

      const senderId = msg.from; // e.g. "919940954744@c.us"
      const normalizedSender = senderId.replace(/[^0-9]/g, '');

      // This customer is talking to us live now, so anything of theirs still sitting in the
      // catch-up queue is stale — answering it later would be a second, out-of-context reply
      // dropped into an active conversation.
      catchupService.forgetChat(senderId);
      console.log(`[DEBUG] Received raw message from: ${senderId} (Normalized: ${normalizedSender})`);

      // Retrieve customer contact details (name and real phone number)
      let customerName = 'Customer';
      let customerPhone = normalizedSender;
      try {
        const contact = await msg.getContact();
        customerName = contact.pushname || contact.name || 'Customer';
        if (contact.number) {
          customerPhone = contact.number.replace(/[^0-9]/g, '');
        }
        console.log(`[DEBUG] Resolved contact details: name="${customerName}", phone="${customerPhone}", rawNumber="${contact.number || ''}"`);
      } catch (contactErr) {
        console.error(`[DEBUG] Failed to retrieve contact for ${senderId}:`, contactErr.message);
      }

      // Try resolving LID using getContactLidAndPhone if it's a LID format
      if (senderId.includes('@lid') && this.client && typeof this.client.getContactLidAndPhone === 'function') {
        try {
          console.log(`[DEBUG] Attempting getContactLidAndPhone for: ${senderId}`);
          const res = await this.client.getContactLidAndPhone([senderId]);
          console.log(`[DEBUG] getContactLidAndPhone response:`, JSON.stringify(res));
          if (res && res.length > 0 && res[0].pn) {
            customerPhone = res[0].pn.replace(/[^0-9]/g, '');
            console.log(`[DEBUG] Successfully resolved LID ${senderId} to Phone: ${customerPhone}`);
          }
        } catch (lidErr) {
          console.error(`[DEBUG] getContactLidAndPhone error:`, lidErr.message);
        }
      }

      // Check allowed test numbers (Safe Mode filter)
      if (config.wati.allowedTestNumbers && config.wati.allowedTestNumbers.length > 0) {
        const isSenderAllowed = config.wati.allowedTestNumbers.includes(normalizedSender) || 
                              config.wati.allowedTestNumbers.includes(customerPhone);
        if (!isSenderAllowed) {
          console.log(`[DEBUG] Blocked message from ${normalizedSender} (Resolved phone: ${customerPhone}) - not in ALLOWED_TEST_NUMBERS`);
          return;
        }
      }

      console.log(`📬 [WhatsApp] Message from ${customerPhone} (LID: ${normalizedSender}): "${msg.body}"${hasMedia ? ' [+media]' : ''}`);

      // Media handling: forward the customer's photo to the owner (so they can see a
      // damaged/wrong jersey) and give the agent a text stand-in so it responds to the
      // image instead of ignoring an empty body. Best-effort — never blocks the reply.
      let messageBody = msg.body || '';
      if (hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media && (media.mimetype || '').startsWith('image') && config.owner?.whatsappNumber && this.status === 'CONNECTED') {
            const owner = config.owner.whatsappNumber.replace(/[^0-9]/g, '') + '@c.us';
            const fwd = new MessageMedia(media.mimetype, media.data, media.filename || 'customer-photo');
            await this.sendText(owner, fwd, {
              caption: `📷 Photo from customer *${customerName}* (${customerPhone})${msg.body ? `\nCaption: "${msg.body}"` : ''}`
            }).catch(e => console.error('[WhatsApp] Failed to forward media to owner:', e.message));
          }
        } catch (mediaErr) {
          console.error('[WhatsApp] downloadMedia failed:', mediaErr.message);
        }
        if (!messageBody.trim()) {
          messageBody = '[The customer just sent a photo/image of their item.]';
        }
      }

      // Show a "typing..." indicator while the agent works (product search + LLM
      // call(s) can take several seconds) so the customer knows we've seen their
      // message instead of wondering if it went through. WhatsApp auto-expires the
      // typing indicator after ~25s if it isn't refreshed, so keep re-sending it.
      try {
        // Some newer @lid chats reject msg.getChat() in whatsapp-web.js; fall back to
        // resolving the chat by the sender id we already reply to.
        let chat = await msg.getChat().catch(() => null);
        if (!chat) chat = await this.client.getChatById(senderId).catch(() => null);
        if (chat) {
          await chat.sendStateTyping();
          typingInterval = setInterval(() => {
            chat.sendStateTyping().catch(() => {});
          }, 20000);
        }
        // If the chat couldn't be resolved, silently skip the typing indicator — it's
        // purely cosmetic and the reply below still sends normally. (Was logging a noisy
        // "Failed to send typing indicator: r" on every message.)
      } catch {
        /* non-fatal: typing indicator is best-effort */
      }

      // Answer using AI Service
      const agentResponse = await aiService.answerQuery(senderId, messageBody, customerName, customerPhone, { hasMedia });

      console.log(`🧠 [AI Agent] Intent: ${agentResponse.intent.toUpperCase()} | Matches: ${agentResponse.suggestedProductIds.length} products | Escalate: ${agentResponse.requiresEscalation}`);

      // Hold the reply back to a human-plausible turnaround (no-op if the agent already
      // took longer than the target), then send through the paced outbound queue.
      await this.humanizeDelay(receivedAt, agentResponse.replyText);
      await this.sendText(senderId, agentResponse.replyText);
      console.log(`📤 [WhatsApp] Sent reply to ${normalizedSender} (${Date.now() - receivedAt}ms turnaround)`);
      // Advance the catch-up watermark so the next sweep — after a restart or reconnect —
      // knows this message is dealt with and starts from here.
      catchupService.noteHandled(msg.timestamp);
    } catch (err) {
      console.error(`❌ [WhatsApp Bot Error]:`, err.message);
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  getStatus() {
    // Retry the account read if 'ready' couldn't get it — the admin page polls every 2.5s,
    // so the panel fills in as soon as client.info becomes available instead of showing
    // "Unknown number" for the life of the session.
    if (this.status === 'CONNECTED' && !this.deviceInfo?.number) this.captureDeviceInfo();

    const device = this.status === 'CONNECTED'
      ? (this.deviceInfo || { number: null, name: null, platform: null, connectedAt: this.connectedAt || null })
      : null;

    return {
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      // Only meaningful while CONNECTED; null otherwise so the console can't show a stale
      // number next to a disconnected badge.
      device,
      loggingOut: this.loggingOut,
      // Phone-number linking: which number the code is for, and the code once WhatsApp issues it.
      pairingPhone: this.status === 'CONNECTED' ? null : this.pairingPhone,
      pairingCode: this.status === 'CODE_READY' ? this.pairingCode : null,
      pairingCodeAt: this.status === 'CODE_READY' ? this.pairingCodeAt : null,
    };
  }
}

const whatsappWebBot = new WhatsAppWebBot();
export default whatsappWebBot;
