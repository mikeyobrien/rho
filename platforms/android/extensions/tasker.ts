/**
 * Tasker Extension - Android UI automation via Tasker + AutoInput
 *
 * Architecture:
 *   Termux sends intents → Tasker receives, performs action → writes result to file
 *   Termux watches result file → returns to caller
 *
 * Requires:
 *   - Tasker app with AutoInput plugin
 *   - Tasker profiles listening for rho.tasker.* intents
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";

// Paths - Use shared storage so Tasker can write results
const RHO_DIR = "/storage/emulated/0/rho";
const DEFAULT_RESULT_FILE = path.join(RHO_DIR, "tasker-result.json");

// Timing constants
const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 150;
const POST_ACTION_DELAY = 400; // Delay after click/type to let UI settle
const RETRY_DELAY = 300;
const DEBUG_LOG = process.env.RHO_TASKER_DEBUG === "1" || process.env.RHO_TASKER_DEBUG === "true";

// Device dimensions - detected dynamically
let deviceWidth = 0;
let deviceHeight = 0;

function getDeviceDimensions(): { width: number; height: number } {
  if (deviceWidth && deviceHeight) {
    return { width: deviceWidth, height: deviceHeight };
  }
  
  // Try adb shell wm size (works in Termux with wireless adb)
  try {
    const output = execSync('timeout 1 adb shell wm size 2>/dev/null || true', { encoding: 'utf-8' });
    const match = output.match(/(\d+)x(\d+)/);
    if (match) {
      deviceWidth = parseInt(match[1], 10);
      deviceHeight = parseInt(match[2], 10);
      return { width: deviceWidth, height: deviceHeight };
    }
  } catch {
    // Continue to next method
  }
  
  // Try dumpsys (may work on some Android setups)
  try {
    const output = execSync('dumpsys window displays 2>/dev/null | grep -o "init=[0-9]*x[0-9]*" | head -1', { encoding: 'utf-8' });
    const match = output.match(/init=(\d+)x(\d+)/);
    if (match) {
      deviceWidth = parseInt(match[1], 10);
      deviceHeight = parseInt(match[2], 10);
      return { width: deviceWidth, height: deviceHeight };
    }
  } catch {
    // Continue to fallback
  }
  
  // Default fallback
  deviceWidth = 1080;
  deviceHeight = 2400;
  return { width: deviceWidth, height: deviceHeight };
}

interface TaskerResult {
  success: boolean;
  clicked?: string;
  typed?: string;
  path?: string;
  texts?: string;
  ids?: string;
  coords?: string;
  app?: string;
  error?: string;
  [key: string]: unknown;
}

// Parsed element from screen read
interface ScreenElement {
  text: string;
  id: string;
  x: number;
  y: number;
}

// Parse ~~~-delimited format from Tasker
// Format: app\n~~~\ncoords\n~~~\nids\n~~~\ntexts\n~~~\nerror
function parseTaskerOutput(content: string): TaskerResult {
  const sections = content.split(/^\s*~~~\s*$/m).map(s => s.trim());
  
  if (sections.length < 4) {
    // Try double-newline as fallback for old format
    const altSections = content.split(/\n\n+/);
    if (altSections.length >= 4) {
      return {
        success: true,
        app: altSections[0]?.trim() || "",
        coords: altSections[1]?.trim() || "",
        ids: altSections[2]?.trim() || "",
        texts: altSections[3]?.trim() || "",
      };
    }
    return { success: false, error: "Invalid response format" };
  }
  
  const app = sections[0]?.trim() || "";
  const coords = sections[1]?.trim() || "";
  const ids = sections[2]?.trim() || "";
  const texts = sections[3]?.trim() || "";
  const errSection = sections[4]?.trim() || "";
  
  // Check for Tasker error
  if (errSection && !errSection.startsWith("%err") && errSection.length > 0 && errSection !== ":") {
    return { success: false, error: errSection };
  }
  
  return {
    success: true,
    app,
    coords,
    ids,
    texts,
  };
}

function splitTexts(texts?: string): string[] {
  if (!texts) return [];
  if (texts.includes('|||')) {
    return texts.split('|||').map(s => s.trim());
  }
  return texts.split(',').map(s => s.trim());
}

// Parse screen result into structured elements
// Uses IDs as source of truth for element count
function parseScreenElements(result: TaskerResult): ScreenElement[] {
  if (!result.ids) return [];
  
  const ids = result.ids.split(',').map(s => s.trim());
  const coordPairs = result.coords?.split(',').map(s => s.trim()) || [];
  
  const texts = splitTexts(result.texts);
  
  const elements: ScreenElement[] = [];
  
  for (let i = 0; i < ids.length; i++) {
    elements.push({
      text: texts[i] || '',
      id: ids[i] || '',
      x: parseInt(coordPairs[i * 2] || '0', 10),
      y: parseInt(coordPairs[i * 2 + 1] || '0', 10),
    });
  }
  return elements;
}

// Normalize text for matching - handle fancy quotes, etc.
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")  // Fancy single quotes to regular
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"'); // Fancy double quotes to regular
}

// Find element by text - searches in both parsed elements and raw texts
// Prioritizes exact/closer matches over partial matches
function findElementByText(elements: ScreenElement[], searchText: string, result?: TaskerResult): ScreenElement | null {
  const normalizedSearch = normalizeText(searchText);
  
  // First try exact match in elements
  let found = elements.find(el => normalizeText(el.text).includes(normalizedSearch));
  if (found) return found;
  
  // If not found, search raw texts and try to find corresponding coords
  if (result?.texts) {
    const rawTexts = splitTexts(result.texts);
    const coordPairs = result.coords?.split(',').map(s => s.trim()) || [];
    const ids = result.ids?.split(',').map(s => s.trim()) || [];
    
    // Find all matches and score them - prefer shorter texts (more likely to be buttons)
    const matches: { index: number; text: string; score: number }[] = [];
    
    for (let i = 0; i < rawTexts.length; i++) {
      const normalized = normalizeText(rawTexts[i]);
      if (normalized.includes(normalizedSearch)) {
        // Score: prefer texts that are closer in length to search text (exact matches)
        const lengthDiff = Math.abs(rawTexts[i].length - searchText.length);
        const score = 1000 - lengthDiff; // Higher score = better match
        matches.push({ index: i, text: rawTexts[i], score });
      }
    }
    
    // Sort by score descending (best match first)
    matches.sort((a, b) => b.score - a.score);
    
    if (matches.length > 0) {
      const bestMatch = matches[0];
      const idCount = ids.length;
      const textCount = rawTexts.length;
      const coordIndex = textCount > idCount ? bestMatch.index - (textCount - idCount) : bestMatch.index;
      
      if (coordIndex >= 0 && coordIndex < idCount) {
        return {
          text: bestMatch.text,
          id: ids[coordIndex] || '',
          x: parseInt(coordPairs[coordIndex * 2] || '0', 10),
          y: parseInt(coordPairs[coordIndex * 2 + 1] || '0', 10),
        };
      }
    }
  }
  
  return null;
}

// Helper: sleep
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function generateResultFile(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(RHO_DIR, `tasker-result-${suffix}.json`);
}

// Ensure directories exist
function ensureDirs(): void {
  try {
    if (!fs.existsSync(RHO_DIR)) fs.mkdirSync(RHO_DIR, { recursive: true });
  } catch {
    // Ignore - dirs might exist or be created by Tasker
  }
}

// Clear result file before sending command
function clearResult(resultFile: string): void {
  try {
    execSync(`rm -f "${resultFile}"`, { stdio: "ignore" });
  } catch {
    // Ignore errors
  }
}

// Read file via shell to bypass Node fs caching on Android shared storage
function readResultFile(resultFile: string, minMtime?: number): string | null {
  try {
    if (minMtime) {
      const stat = fs.statSync(resultFile);
      if (stat.mtimeMs < minMtime) return null;
    }
  } catch {
    return null;
  }

  try {
    const content = execSync(`cat "${resultFile}" 2>/dev/null`, { encoding: "utf-8" });
    if (content && DEBUG_LOG) {
      try {
        fs.writeFileSync(path.join(RHO_DIR, "tasker-debug.log"), content);
      } catch {
        // Ignore debug log failures
      }
    }
    return content.trim() || null;
  } catch {
    return null;
  }
}

// Wait for result file to appear (with timeout)
// Uses startTime to ensure we only accept files written after we started
async function waitForResult(
  resultFile: string,
  timeoutMs = DEFAULT_TIMEOUT,
  startTime?: number,
  checkPng = false
): Promise<TaskerResult> {
  const start = Date.now();
  const legacyPng = path.join(RHO_DIR, "tasker-result.png");
  const minMtime = (startTime || start) - 5000;
  const fallbackFile = resultFile === DEFAULT_RESULT_FILE ? null : DEFAULT_RESULT_FILE;

  while (Date.now() - start < timeoutMs) {
    if (checkPng && fs.existsSync(legacyPng)) {
      const stat = fs.statSync(legacyPng);
      if (stat.mtimeMs > minMtime) {
        return { success: true };
      }
    }

    let content = readResultFile(resultFile, minMtime);
    let usedFile = resultFile;

    if (!content && fallbackFile) {
      const fallbackContent = readResultFile(fallbackFile, minMtime);
      if (fallbackContent) {
        content = fallbackContent;
        usedFile = fallbackFile;
      }
    }

    if (content) {
      if (checkPng && content.startsWith('\x89PNG')) {
        clearResult(usedFile);
        return { success: true };
      }
      // Try parsing as JSON first
      if (content.startsWith('{')) {
        try {
          const jsonResult = JSON.parse(content) as TaskerResult;
          clearResult(usedFile);
          return jsonResult;
        } catch {
          // Not valid JSON, continue
        }
      }
      if (content.includes('~~~')) {
        const result = parseTaskerOutput(content);
        if (result.success || result.error) {
          clearResult(usedFile);
          return result;
        }
      }
    }
    await sleep(POLL_INTERVAL);
  }

  return { success: false, error: "Timeout waiting for Tasker response" };
}

// Send intent to Tasker via am broadcast
function sendIntent(action: string, extras: Record<string, string>): void {
  const args = ["broadcast", "--user", "0", "-a", `rho.tasker.${action}`];

  for (const [key, value] of Object.entries(extras)) {
    args.push("-e", key, value);
  }

  const result = spawnSync("am", args, { stdio: "ignore" });
  if (result.error) {
    throw new Error(`Failed to send intent: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Failed to send intent (exit ${result.status})`);
  }
}

// Execute a Tasker command and wait for result
async function taskerCommand(
  action: string,
  params: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT,
  checkPng = false
): Promise<TaskerResult> {
  ensureDirs();
  
  // Record start time before clearing, so we know to only accept newer files
  const startTime = Date.now();
  const resultFile = generateResultFile();
  clearResult(resultFile);

  // Add result file path so Tasker knows where to write
  params.result_file = resultFile;

  sendIntent(action, params);
  return waitForResult(resultFile, timeoutMs, startTime, checkPng);
}

// ============================================================================
// Robust wrapper functions
// ============================================================================

// Read screen with retry logic
async function readScreenWithRetry(maxAttempts = 3, timeoutMs = 5000): Promise<TaskerResult> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await taskerCommand("read_screen", {}, timeoutMs);
    if (result.success) return result;
    await sleep(RETRY_DELAY + i * 200); // Increasing delay on retries
  }
  return { success: false, error: `read_screen failed after ${maxAttempts} attempts` };
}

// Check if specific text is on screen
function screenContainsText(result: TaskerResult, searchText: string): boolean {
  if (!result.success || !result.texts) return false;
  return result.texts.toLowerCase().includes(searchText.toLowerCase());
}

// Open app by name - uses Tasker to launch
async function openAppAndRead(appName: string, timeoutMs = DEFAULT_TIMEOUT): Promise<TaskerResult> {
  // Use Tasker to launch the app by name
  const result = await taskerCommand("launch_app", { app: appName, package: appName }, timeoutMs);
  if (!result.success) {
    return result;
  }
  
  await sleep(800); // Apps take longer to launch than page loads
  
  const screen = await readScreenWithRetry(3, 5000);
  return {
    success: true,
    app: screen.app || appName,
    launched: appName,
    ...screen,
  };
}

// Wait for specific text to appear on screen
async function waitForText(text: string, timeoutMs = 10000): Promise<TaskerResult | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const screen = await taskerCommand("read_screen", {}, 3000);
    if (screenContainsText(screen, text)) {
      return screen;
    }
    await sleep(500);
  }
  return null;
}

// Click and wait for UI to settle, then read screen
// Priority: 1) Direct coordinates (x,y format), 2) Element lookup, 3) Text
async function clickAndRead(target: string, timeoutMs = DEFAULT_TIMEOUT): Promise<TaskerResult> {
  let xcoord = "", ycoord = "", elementId = "";
  
  // Check if target is direct coordinates (e.g., "127,2407")
  const coordMatch = target.match(/^(\d+)\s*,\s*(\d+)$/);
  if (coordMatch) {
    xcoord = coordMatch[1];
    ycoord = coordMatch[2];
  } else {
    // Look up element by text
    const screen = await taskerCommand("read_screen", {}, 5000);
    
    if (screen.success) {
      const elements = parseScreenElements(screen);
      const element = findElementByText(elements, target, screen);
      if (element) {
        // Prioritize coordinates for maximum reliability
        if (element.x > 0 && element.y > 0) {
          xcoord = String(element.x);
          ycoord = String(element.y);
          // We still send elementId as a secondary backup if you want, 
          // but Tasker should use xcoord first now.
          if (element.id) elementId = element.id;
        } else if (element.id) {
          elementId = element.id;
        }
      }
    }
  }
  
  // Send click - Tasker should try: coords first, then elementId, then target text
  const params: Record<string, string> = { target };
  if (xcoord) params.xcoord = xcoord;
  if (ycoord) params.ycoord = ycoord;
  if (elementId) params.elementId = elementId;
  
  const clickResult = await taskerCommand("click", params, timeoutMs);
  
  if (!clickResult.success) {
    return clickResult;
  }
  
  await sleep(POST_ACTION_DELAY);
  
  const newScreen = await readScreenWithRetry(2, 5000);
  return {
    success: true,
    clicked: target,
    ...newScreen,
  };
}

// Open URL and wait for page to load (checks for specific text or just waits)
async function openUrlAndWait(
  url: string, 
  waitForTextStr?: string, 
  timeoutMs = 15000
): Promise<TaskerResult> {
  const openResult = await taskerCommand("open_url", { url }, 5000);
  if (!openResult.success) {
    return openResult;
  }

  // Wait for browser to start loading
  await sleep(1500);

  if (waitForTextStr) {
    const screen = await waitForText(waitForTextStr, timeoutMs);
    if (screen) {
      return { success: true, url, ...screen };
    }
    return { success: false, error: `Timeout waiting for "${waitForTextStr}"` };
  }

  // Just read the screen after the page loads
  const screen = await readScreenWithRetry(5, 5000);
  return { success: true, url, ...screen };
}

// Type text and read screen after
async function typeAndRead(text: string, target?: string): Promise<TaskerResult> {
  const typeResult = await taskerCommand("type", { text, target: target || "" }, DEFAULT_TIMEOUT);
  if (!typeResult.success) {
    return typeResult;
  }
  
  await sleep(POST_ACTION_DELAY);
  
  const screen = await readScreenWithRetry(2, 5000);
  return {
    success: true,
    typed: text,
    ...screen,
  };
}

// ============================================================================
// Extension registration
// ============================================================================

export default function (pi: ExtensionAPI) {
  ensureDirs();

  // Register tasker tool for UI automation
  pi.registerTool({
    name: "tasker",
    label: "Tasker",
    description: `Control Android UI via Tasker. Actions:
- open_url: Open URL in browser (optionally wait for text)
- open_app: Open app by name (e.g., "Telegram", "Chrome")
- click: Click element by text or coordinates (auto-reads screen after)
- type: Type text (auto-reads screen after)
- read_screen: Read all visible UI text
- read_elements: Read UI elements with their coordinates (for precise clicking)
- read_screen_text: Read all text on screen (not just clickable)
- screenshot: Take a screenshot
- scroll: Scroll up/down
- back: Press back button
- home: Go to home screen
- wait_for: Wait for specific text to appear`,
    parameters: Type.Object({
      action: StringEnum([
        "open_url", 
        "open_app",
        "click", 
        "type", 
        "screenshot", 
        "read_screen",
        "read_elements",
        "read_screen_text",
        "scroll",
        "back", 
        "home",
        "wait_for"
      ] as const),
      url: Type.Optional(Type.String({ description: "URL to open (for open_url)" })),
      app: Type.Optional(Type.String({ description: "App name to open (for open_app)" })),
      target: Type.Optional(Type.String({ description: "Text or element ID to click/target" })),
      text: Type.Optional(Type.String({ description: "Text to type (for type action)" })),
      wait_for: Type.Optional(Type.String({ description: "Text to wait for (for open_url or wait_for action)" })),
      direction: Type.Optional(Type.String({ description: "Scroll direction: up or down" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 10000)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const timeout = params.timeout || DEFAULT_TIMEOUT;

      try {
        let result: TaskerResult;

        switch (params.action) {
          case "open_url": {
            if (!params.url) {
              return { content: [{ type: "text", text: "Error: url required" }], details: { error: true } };
            }
            const waitForText = params.wait_for || params.text;
            // Use robust open that waits for load
            result = await openUrlAndWait(params.url, waitForText, timeout);
            break;
          }

          case "open_app": {
            if (!params.app) {
              return { content: [{ type: "text", text: "Error: app name required" }], details: { error: true } };
            }
            // Use Tasker to launch app by name
            result = await openAppAndRead(params.app, timeout);
            break;
          }

          case "click": {
            if (!params.target) {
              return { content: [{ type: "text", text: "Error: target required" }], details: { error: true } };
            }
            // Use robust click that reads screen after
            result = await clickAndRead(params.target, timeout);
            break;
          }

          case "type": {
            if (!params.text) {
              return { content: [{ type: "text", text: "Error: text required" }], details: { error: true } };
            }
            // Use robust type that reads screen after
            result = await typeAndRead(params.text, params.target);
            break;
          }

          case "screenshot": {
            // Generate screenshot path
            const screenshotPath = path.join(RHO_DIR, `screenshot-${Date.now()}.png`);
            
            // Send screenshot path to Tasker - it will save the screenshot there
            result = await taskerCommand("read_screenshot", { screenshot_file: screenshotPath }, timeout);
            
            if (result.success && fs.existsSync(screenshotPath)) {
              result.path = screenshotPath;
              
              // Keep only the 3 most recent screenshots
              try {
                const files = fs.readdirSync(RHO_DIR)
                  .filter(f => f.startsWith('screenshot-') && f.endsWith('.png'))
                  .map(f => ({ name: f, path: path.join(RHO_DIR, f), mtime: fs.statSync(path.join(RHO_DIR, f)).mtimeMs }))
                  .sort((a, b) => b.mtime - a.mtime); // newest first
                
                // Delete all but the 3 newest
                for (const file of files.slice(3)) {
                  fs.unlinkSync(file.path);
                }
              } catch { /* ignore cleanup errors */ }
            } else if (!result.success) {
              result.error = result.error || "Screenshot failed";
            }
            break;
          }

          case "read_screen": {
            // Use retry logic for reliability
            result = await readScreenWithRetry(3, timeout);
            break;
          }

          case "read_elements": {
            // Read screen and return structured elements with coordinates
            const screenResult = await readScreenWithRetry(3, timeout);
            if (screenResult.success) {
              const elements = parseScreenElements(screenResult);
              const dims = getDeviceDimensions();
              result = {
                success: true,
                app: screenResult.app,
                device: `${dims.width}x${dims.height}`,
                elements: elements.filter(e => e.text).map(e => ({
                  text: e.text,
                  x: e.x,
                  y: e.y,
                  id: e.id
                }))
              };
            } else {
              result = screenResult;
            }
            break;
          }

          case "read_screen_text": {
            result = await taskerCommand("read_screen_text", {}, timeout);
            break;
          }

          case "scroll": {
            const direction = params.direction || "down";
            result = await taskerCommand("scroll", { direction }, timeout);
            if (result.success) {
              await sleep(POST_ACTION_DELAY);
              const screen = await readScreenWithRetry(2, 5000);
              result = { ...result, ...screen };
            }
            break;
          }

          case "back": {
            result = await taskerCommand("back", {}, timeout);
            if (result.success) {
              await sleep(POST_ACTION_DELAY);
              const screen = await readScreenWithRetry(2, 5000);
              result = { ...result, ...screen };
            }
            break;
          }

          case "home": {
            result = await taskerCommand("home", {}, timeout);
            if (result.success) {
              await sleep(POST_ACTION_DELAY);
              const screen = await readScreenWithRetry(2, 5000);
              result = { ...result, ...screen };
            }
            break;
          }

          case "wait_for": {
            const waitText = params.wait_for || params.text;
            if (!waitText) {
              return { content: [{ type: "text", text: "Error: wait_for text required" }], details: { error: true } };
            }
            const screen = await waitForText(waitText, timeout);
            if (screen) {
              result = { success: true, found: waitText, ...screen };
            } else {
              result = { success: false, error: `Text "${waitText}" not found within timeout` };
            }
            break;
          }

          default:
            return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: { error: true } };
        }

        if (result.success) {
          // Format output nicely
          const output = formatResult(result);
          return {
            content: [{ type: "text", text: output }],
            details: result,
          };
        } else {
          return {
            content: [{ type: "text", text: `Error: ${result.error || "unknown"}` }],
            details: { error: true, ...result },
          };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: true } };
      }
    },
  });

  // Register /tasker command for manual testing
  pi.registerCommand("tasker", {
    description: "Test Tasker integration (usage: /tasker <action> [args])",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const action = parts[0];

      if (!action) {
        ctx.ui.notify("Usage: /tasker <open_url|open_app|click|type|read_screen|scroll|back|home> [args]", "error");
        return;
      }

      ctx.ui.notify(`Sending: ${action}...`, "info");

      try {
        let result: TaskerResult;

        switch (action) {
          case "open_url":
            result = await openUrlAndWait(parts[1] || "https://example.com");
            break;
          case "open_app":
            result = await openAppAndRead(parts.slice(1).join(" ") || "Telegram");
            break;
          case "click":
            result = await clickAndRead(parts.slice(1).join(" ") || "OK");
            break;
          case "type":
            result = await typeAndRead(parts.slice(1).join(" ") || "hello");
            break;
          case "screenshot": {
            const screenshotPath = path.join(RHO_DIR, `screenshot-${Date.now()}.png`);
            result = await taskerCommand("read_screenshot", { screenshot_file: screenshotPath });
            if (result.success && fs.existsSync(screenshotPath)) {
              result.path = screenshotPath;
            }
            break;
          }
          case "read_screen":
            result = await readScreenWithRetry(3);
            break;
          case "scroll":
            result = await taskerCommand("scroll", { direction: parts[1] || "down" });
            break;
          case "back":
            result = await taskerCommand("back", {});
            break;
          case "home":
            result = await taskerCommand("home", {});
            break;
          default:
            ctx.ui.notify(`Unknown action: ${action}`, "error");
            return;
        }

        if (result.success) {
          ctx.ui.notify(`✓ ${action}`, "success");
        } else {
          ctx.ui.notify(`✗ ${result.error}`, "error");
        }
      } catch (err) {
        ctx.ui.notify(`Error: ${err}`, "error");
      }
    },
  });
}

// Format result for nicer output
function formatResult(result: TaskerResult): string {
  const parts: string[] = [];
  
  if (result.app) {
    parts.push(`App: ${result.app}`);
  }
  
  if (result.clicked) {
    parts.push(`Clicked: ${result.clicked}`);
  }
  
  if (result.typed) {
    parts.push(`Typed: ${result.typed}`);
  }
  
  if (result.url) {
    parts.push(`Opened: ${result.url}`);
  }
  
  if (result.found) {
    parts.push(`Found: ${result.found}`);
  }

  if (result.device) {
    parts.push(`Device: ${result.device}`);
  }

  if (result.elements && Array.isArray(result.elements)) {
    // Format elements with coordinates
    const elemList = result.elements as Array<{text: string; x: number; y: number; id: string}>;
    const formatted = elemList.map(e => `  "${e.text}" @ (${e.x},${e.y})`).join('\n');
    parts.push(`Elements (${elemList.length}):\n${formatted}`);
  }
  
  if (result.texts) {
    // Truncate very long text lists
    const texts = result.texts;
    if (texts.length > 2000) {
      parts.push(`Screen text: ${texts.slice(0, 2000)}... (truncated)`);
    } else {
      parts.push(`Screen text: ${texts}`);
    }
  }
  
  if (parts.length === 0) {
    return JSON.stringify(result);
  }
  
  return parts.join("\n");
}
