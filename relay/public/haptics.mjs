/**
 * haptics.mjs — named haptic effects for the tablet console.
 *
 * This is a dependency-free ES-module port of `web-haptics` by Lochie Axon
 * (https://github.com/lochie/web-haptics). The upstream package ships only
 * TypeScript sources and is published as a tsup/esbuild bundle, so it cannot be
 * vendored verbatim into a page that has no build step. The preset table below
 * is reproduced unchanged from `src/lib/web-haptics/patterns.ts`, and the PWM
 * intensity model and the iOS switch-element fallback follow
 * `src/lib/web-haptics/index.ts`. The React/Vue/Svelte adapters, the debug
 * audio channel and the on-screen toggle switch are omitted — this page needs
 * none of them.
 *
 * MIT License
 *
 * Copyright (c) 2025 Lochie Axon
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const TOGGLE_MIN = 16;    // ms between switch clicks at intensity 1 (every frame)
const TOGGLE_MAX = 184;   // range above min (0.5 intensity ~ 100ms)
const MAX_PHASE_MS = 1000; // browsers refuse to buzz longer than this in one go
const PWM_CYCLE = 20;     // ms per intensity modulation cycle

/**
 * Named effects, verbatim from upstream `patterns.ts`. The three groups mirror
 * iOS' UIFeedbackGenerator families, so picking one by name keeps call sites
 * describing *meaning* rather than millisecond soup.
 */
export const defaultPatterns = {
  // --- Notification (UINotificationFeedbackGenerator) ---
  success: {
    // ascending double-tap indicating success.
    pattern: [
      { duration: 30, intensity: 0.5 },
      { delay: 60, duration: 40, intensity: 1 }
    ]
  },
  warning: {
    // two taps with hesitation indicating a warning.
    pattern: [
      { duration: 40, intensity: 0.8 },
      { delay: 100, duration: 40, intensity: 0.6 }
    ]
  },
  error: {
    // three rapid harsh taps indicating an error.
    pattern: [
      { duration: 40, intensity: 0.7 },
      { delay: 40, duration: 40, intensity: 0.7 },
      { delay: 40, duration: 40, intensity: 0.9 },
      { delay: 40, duration: 50, intensity: 0.6 }
    ]
  },

  // --- Impact (UIImpactFeedbackGenerator) ---
  light: {
    // single light tap indicating a minor impact.
    pattern: [{ duration: 15, intensity: 0.4 }]
  },
  medium: {
    // moderate tap for standard interactions.
    pattern: [{ duration: 25, intensity: 0.7 }]
  },
  heavy: {
    // strong tap for significant interactions.
    pattern: [{ duration: 35, intensity: 1 }]
  },
  soft: {
    // soft, cushioned tap with a rounded feel.
    pattern: [{ duration: 40, intensity: 0.5 }]
  },
  rigid: {
    // hard, crisp tap with a precise feel.
    pattern: [{ duration: 10, intensity: 1 }]
  },

  // --- Selection (UISelectionFeedbackGenerator) ---
  selection: {
    // subtle tap for selection changes.
    pattern: [{ duration: 8, intensity: 0.3 }]
  },

  // --- Custom ---
  nudge: {
    // two quick taps with a pause, indicating a nudge or reminder.
    pattern: [
      { duration: 80, intensity: 0.8 },
      { delay: 80, duration: 50, intensity: 0.3 }
    ]
  },
  buzz: {
    // rapid, low-intensity taps creating a buzzing effect.
    pattern: [{ duration: 1000, intensity: 1 }]
  }
};

/**
 * Coerce any accepted input into a plain vibration list.
 * Copies every entry, because `trigger` clamps durations in place and the
 * preset table must survive being fired a few thousand times a session.
 * @param {string|number|Array|object} input
 * @returns {{duration: number, intensity?: number, delay?: number}[]|null}
 */
function normalizeInput(input) {
  if ( typeof input === "number" ) return [{ duration: input }];

  if ( typeof input === "string" ) {
    const preset = defaultPatterns[input];
    if ( !preset ) {
      console.warn(`[haptics] Unknown preset: "${input}"`);
      return null;
    }
    return preset.pattern.map(v => ({ ...v }));
  }

  if ( Array.isArray(input) ) {
    if ( input.length === 0 ) return [];

    // number[] shorthand — alternating on/off durations, as navigator.vibrate takes.
    if ( typeof input[0] === "number" ) {
      const out = [];
      for ( let i = 0; i < input.length; i += 2 ) {
        const delay = i > 0 ? input[i - 1] : 0;
        out.push(delay > 0 ? { delay, duration: input[i] } : { duration: input[i] });
      }
      return out;
    }
    return input.map(v => ({ ...v }));
  }

  return input.pattern.map(v => ({ ...v }));
}

/**
 * The Vibration API has no amplitude control, so intensity is faked by pulse-
 * width modulation: chop the buzz into 20ms cycles and keep the motor on for
 * `intensity` of each one.
 * @param {number} duration
 * @param {number} intensity  0..1
 * @returns {number[]} flat on/off segments
 */
function modulateVibration(duration, intensity) {
  if ( intensity >= 1 ) return [duration];
  if ( intensity <= 0 ) return [];

  const onTime = Math.max(1, Math.round(PWM_CYCLE * intensity));
  const offTime = PWM_CYCLE - onTime;
  const result = [];

  let remaining = duration;
  while ( remaining >= PWM_CYCLE ) {
    result.push(onTime, offTime);
    remaining -= PWM_CYCLE;
  }
  if ( remaining > 0 ) {
    const remOn = Math.max(1, Math.round(remaining * intensity));
    result.push(remOn);
    const remOff = remaining - remOn;
    if ( remOff > 0 ) result.push(remOff);
  }
  return result;
}

/**
 * Flatten a vibration list into the alternating on/off array navigator.vibrate
 * wants, folding delays into the preceding off-slot so the pattern stays legal.
 * @param {object[]} vibrations
 * @param {number} defaultIntensity
 * @returns {number[]}
 */
function toVibratePattern(vibrations, defaultIntensity) {
  const result = [];

  for ( const vib of vibrations ) {
    const intensity = Math.max(0, Math.min(1, vib.intensity ?? defaultIntensity));
    const delay = vib.delay ?? 0;

    if ( delay > 0 ) {
      if ( result.length > 0 && (result.length % 2 === 0) ) result[result.length - 1] += delay;
      else {
        if ( result.length === 0 ) result.push(0);
        result.push(delay);
      }
    }

    const modulated = modulateVibration(vib.duration, intensity);
    if ( modulated.length === 0 ) {
      // Zero intensity — the vibration still occupies time, just silently.
      if ( result.length > 0 && (result.length % 2 === 0) ) result[result.length - 1] += vib.duration;
      else if ( vib.duration > 0 ) result.push(0, vib.duration);
      continue;
    }
    result.push(...modulated);
  }
  return result;
}

let instanceCounter = 0;

/** Fires named effects on whatever haptic channel the device actually has. */
export class WebHaptics {
  #instanceId = ++instanceCounter;
  #label = null;
  #domInitialized = false;
  #rafId = null;
  #patternResolve = null;

  /** True when navigator.vibrate exists — false on every iOS browser. */
  static isSupported = (typeof navigator !== "undefined") && (typeof navigator.vibrate === "function");

  /**
   * Play an effect. Never throws and never rejects, so call sites can fire and
   * forget it on platforms with no haptics at all.
   * @param {string|number|Array|object} [input]  Preset name, ms, or pattern.
   * @param {{intensity?: number}} [options]      Intensity for entries that set none.
   * @returns {Promise<void>} Resolves when the pattern has played out.
   */
  async trigger(input = [{ duration: 25, intensity: 0.7 }], options) {
    try {
      const vibrations = normalizeInput(input);
      if ( !vibrations?.length ) return;

      const defaultIntensity = Math.max(0, Math.min(1, options?.intensity ?? 0.5));

      for ( const vib of vibrations ) {
        if ( vib.duration > MAX_PHASE_MS ) vib.duration = MAX_PHASE_MS;
        const badDelay = (vib.delay !== undefined) && (!Number.isFinite(vib.delay) || (vib.delay < 0));
        if ( !Number.isFinite(vib.duration) || (vib.duration < 0) || badDelay ) {
          console.warn("[haptics] Durations and delays must be finite non-negative numbers.");
          return;
        }
      }

      if ( WebHaptics.isSupported ) {
        navigator.vibrate(toVibratePattern(vibrations, defaultIntensity));
        return;
      }

      // iOS has no Vibration API, but Safari 17.4+ plays a system tick whenever a
      // `switch` checkbox toggles — clicking a hidden one is the only lever there.
      this.#ensureDOM();
      if ( !this.#label ) return;
      this.#stopPattern();

      const firstDelay = vibrations[0]?.delay ?? 0;
      const firstClickFired = firstDelay === 0;
      // Must click inside the originating user gesture or iOS ignores it.
      if ( firstClickFired ) this.#label.click();

      await this.#runPattern(vibrations, defaultIntensity, firstClickFired);
    } catch ( err ) {
      console.warn("[haptics] trigger failed", err);
    }
  }

  /** Stop whatever is currently playing. */
  cancel() {
    this.#stopPattern();
    if ( WebHaptics.isSupported ) navigator.vibrate(0);
  }

  /** Drop the fallback element. Only needed if the page tears itself down. */
  destroy() {
    this.#stopPattern();
    this.#label?.remove();
    this.#label = null;
    this.#domInitialized = false;
  }

  #stopPattern() {
    if ( this.#rafId !== null ) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    this.#patternResolve?.();
    this.#patternResolve = null;
  }

  /**
   * Walk the pattern on rAF, re-clicking the switch often enough to read as a
   * continuous buzz. Click cadence carries intensity: denser ticks feel stronger.
   * @param {object[]} vibrations
   * @param {number} defaultIntensity
   * @param {boolean} firstClickFired
   * @returns {Promise<void>}
   */
  #runPattern(vibrations, defaultIntensity, firstClickFired) {
    return new Promise(resolve => {
      this.#patternResolve = resolve;

      const phases = [];
      let cumulative = 0;
      for ( const vib of vibrations ) {
        const intensity = Math.max(0, Math.min(1, vib.intensity ?? defaultIntensity));
        const delay = vib.delay ?? 0;
        if ( delay > 0 ) {
          cumulative += delay;
          phases.push({ end: cumulative, isOn: false, intensity: 0 });
        }
        cumulative += vib.duration;
        phases.push({ end: cumulative, isOn: true, intensity });
      }
      const totalDuration = cumulative;

      let startTime = 0, lastToggleTime = -1, clicked = firstClickFired;

      const loop = time => {
        if ( startTime === 0 ) startTime = time;
        const elapsed = time - startTime;

        if ( elapsed >= totalDuration ) {
          this.#rafId = null;
          this.#patternResolve = null;
          resolve();
          return;
        }

        let phase = phases[0];
        for ( const p of phases ) {
          if ( elapsed < p.end ) { phase = p; break; }
        }

        if ( phase.isOn ) {
          const toggleInterval = TOGGLE_MIN + ((1 - phase.intensity) * TOGGLE_MAX);
          if ( lastToggleTime === -1 ) {
            lastToggleTime = time;
            if ( !clicked ) {
              this.#label?.click();
              clicked = true;
            }
          } else if ( (time - lastToggleTime) >= toggleInterval ) {
            this.#label?.click();
            lastToggleTime = time;
          }
        }
        this.#rafId = requestAnimationFrame(loop);
      };
      this.#rafId = requestAnimationFrame(loop);
    });
  }

  /** Build the hidden switch used by the iOS fallback, once, on first need. */
  #ensureDOM() {
    if ( this.#domInitialized || (typeof document === "undefined") ) return;

    const id = `web-haptics-${this.#instanceId}`;
    const label = document.createElement("label");
    label.setAttribute("for", id);
    label.setAttribute("aria-hidden", "true");
    label.style.display = "none";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("switch", "");
    checkbox.id = id;
    checkbox.style.display = "none";

    label.append(checkbox);
    document.body.append(label);
    this.#label = label;
    this.#domInitialized = true;
  }
}

/** Shared instance — one hidden switch per page is plenty. */
export const haptics = new WebHaptics();
