/**
 * jspsych-instructed-refreshing
 *
 * Instructed ("guided") refreshing paradigm after Souza, Rerko & Oberauer (2015),
 * with two refresh modes:
 *   - 'mental':   an arrow points to an item; participants think of its color.
 *   - 'physical': an arrow points to an item and a color wheel appears;
 *                 participants reproduce the item's color by clicking the wheel.
 * The trial ends with a continuous color report of one target item.
 *
 * Every wheel (each refresh step and the final probe) gets its own random rotation.
 * Requires schurgin_colors.js (defines SCHURGIN_COLORS) to be loaded first.
 *
 * Built on the continuous-color plugins by Tim Brady & Janna Wennberg.
 */

var ir_css_added = false;

var jsPsychInstructedRefreshing = (function (jspsych) {
    'use strict';
    const P = jspsych.ParameterType;

    const info = {
        name: 'instructed-refreshing',
        parameters: {
            refresh_mode:         { type: P.STRING, default: 'mental', description: "'mental' or 'physical'." },
            cue_sequence:         { type: P.INT, array: true, default: [], description: 'Item index cued on each refresh step.' },
            target_index:         { type: P.INT, default: 0, description: 'Item index tested at the end of the trial.' },
            item_colors:          { type: P.INT, array: true, default: [], description: 'Optional colors (0-359). Random if empty.' },

            set_size:             { type: P.INT, default: 6 },
            min_difference:       { type: P.INT, default: 30, description: 'Minimum distance between item colors (deg).' },
            item_size:            { type: P.INT, default: 60, description: 'Item diameter (px).' },
            radius:               { type: P.INT, default: 150, description: 'Radius of the item ring (px).' },
            wheel_thickness:      { type: P.INT, default: 24, description: 'Thickness of the color wheel (px).' },

            iti:                  { type: P.INT, default: 1000 },
            display_time:         { type: P.INT, default: 1000, description: 'Memory array duration.' },
            pre_cue_delay:        { type: P.INT, default: 500, description: 'Blank between array offset and first cue.' },
            cue_duration:         { type: P.INT, default: 2500, description: 'Duration of each refresh step (same in both modes).' },
            inter_cue_interval:   { type: P.INT, default: 250, description: 'Blank between refresh steps.' },
            post_cue_delay:       { type: P.INT, default: 500, description: 'Blank between last cue and probe.' },
            probe_max_rt:         { type: P.INT, default: null, description: 'Deadline for the final report (ms); null = none.' },

            show_wheel_in_mental: { type: P.BOOL, default: false, description: 'Show a (non-clickable) wheel during mental refresh steps, to match the display across modes.' },
            hover_preview:        { type: P.BOOL, default: true, description: 'Fill the cued/probed item with the hovered color.' },
            feedback:             { type: P.BOOL, default: false, description: 'Feedback on the final report only.' },
            bg_color:             { type: P.STRING, default: '#DDDDDD' },

            block_label:          { type: P.STRING, default: '' },
            is_practice:          { type: P.BOOL, default: false },
        },
    };

    /* ---------------- helpers ---------------- */
    const wrap360 = (v) => ((v % 360) + 360) % 360;
    const circErr = (reported, target) => {           // signed error in (-180, 180]
        let e = wrap360(reported - target);
        if (e > 180) e -= 360;
        return e;
    };
    const rgbStr = (deg) => {
        const c = SCHURGIN_COLORS[Math.round(wrap360(deg)) % 360];
        return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
    };
    const randSpin = () => Math.floor(Math.random() * 360);

    function generateColors(n, minDiff) {
        for (let attempt = 0; attempt < 1000; attempt++) {
            const cols = [];
            for (let i = 0; i < n; i++) {
                let placed = false;
                for (let tries = 0; tries < 500; tries++) {
                    const c = Math.floor(Math.random() * 360);
                    if (cols.every(a => Math.abs(circErr(c, a)) >= minDiff)) { cols.push(c); placed = true; break; }
                }
                if (!placed) break;
            }
            if (cols.length === n) return cols;
        }
        throw new Error('Could not generate colors with min_difference=' + minDiff);
    }

    class InstructedRefreshingPlugin {
        constructor(jsPsych) { this.jsPsych = jsPsych; }

        trial(display_element, trial) {
            const jsP = this.jsPsych;
            const api = jsP.pluginAPI;
            const n = trial.set_size;
            const seq = trial.cue_sequence.slice();
            const target = trial.target_index;
            const physical = trial.refresh_mode === 'physical';

            if (!['mental', 'physical'].includes(trial.refresh_mode)) throw new Error('refresh_mode must be mental or physical');
            if (target < 0 || target >= n) throw new Error('target_index out of range');
            if (seq.some(i => i < 0 || i >= n)) throw new Error('cue_sequence index out of range');

            const colors = trial.item_colors.length === n ? trial.item_colors.slice() : generateColors(n, trial.min_difference);

            /* ---------- CSS ---------- */
            if (!ir_css_added) {
                const style = document.createElement('style');
                style.textContent = `
                    #ir-box { position: relative; margin: 0 auto; border: 1px solid #888; }
                    .ir-item { position: absolute; border-radius: 50%; box-sizing: border-box;
                               outline: 2px solid #555; outline-offset: 3px; }
                    .ir-item.probed { outline: 5px solid #111; }
                    #ir-fix { position: absolute; transform: translate(-50%, -50%);
                              font-size: 24px; text-align: center; user-select: none;
                              font-family: Georgia, serif; line-height: 1.2; }
                `;
                document.head.appendChild(style);
                ir_css_added = true;
            }

            /* ---------- layout ---------- */
            const wheelR = trial.radius + trial.item_size / 2 + 45;
            const box = Math.round(2 * (wheelR + trial.wheel_thickness + 20));
            const c = box / 2;
            const itemPos = [];
            for (let i = 0; i < n; i++) {
                const a = (-90 + i * 360 / n) * Math.PI / 180;
                itemPos.push({ x: c + trial.radius * Math.cos(a), y: c + trial.radius * Math.sin(a), a });
            }

            let html = `<div id="ir-box" style="width:${box}px;height:${box}px;background:${trial.bg_color};">
                <canvas id="ir-wheel" width="${box}" height="${box}"
                    style="position:absolute;left:0;top:0;display:none;"></canvas>
                <svg id="ir-cue" width="${box}" height="${box}"
                    style="position:absolute;left:0;top:0;pointer-events:none;"></svg>`;
            for (let i = 0; i < n; i++) {
                html += `<div id="ir-item-${i}" class="ir-item" style="
                    left:${itemPos[i].x - trial.item_size / 2}px; top:${itemPos[i].y - trial.item_size / 2}px;
                    width:${trial.item_size}px; height:${trial.item_size}px;"></div>`;
            }
            html += `<div id="ir-fix" style="left:${c}px; top:${c}px;">+</div></div>`;
            display_element.innerHTML = html;

            const canvas = display_element.querySelector('#ir-wheel');
            const ctx = canvas.getContext('2d');
            const svg = display_element.querySelector('#ir-cue');
            const fix = display_element.querySelector('#ir-fix');
            const item = (i) => display_element.querySelector('#ir-item-' + i);
            const setItemColor = (i, deg) => { item(i).style.backgroundColor = deg === null ? '' : rgbStr(deg); };

            /* ---------- wheel ---------- */
            function drawWheel(spin) {
                ctx.clearRect(0, 0, box, box);
                ctx.lineWidth = trial.wheel_thickness;
                for (let d = 0; d < 360; d++) {
                    const s = wrap360(d + spin);
                    ctx.beginPath();
                    ctx.arc(c, c, wheelR, (s - 0.6) * Math.PI / 180, (s + 0.6) * Math.PI / 180);
                    ctx.strokeStyle = rgbStr(d);
                    ctx.stroke();
                }
                canvas.style.display = 'block';
            }
            function drawMarker(screenDeg, width, color) {
                const a = screenDeg * Math.PI / 180;
                const r0 = wheelR - trial.wheel_thickness / 2 - 8, r1 = wheelR + trial.wheel_thickness / 2 + 8;
                ctx.beginPath();
                ctx.moveTo(c + r0 * Math.cos(a), c + r0 * Math.sin(a));
                ctx.lineTo(c + r1 * Math.cos(a), c + r1 * Math.sin(a));
                ctx.lineWidth = width;
                ctx.strokeStyle = color;
                ctx.stroke();
            }
            const hideWheel = () => { ctx.clearRect(0, 0, box, box); canvas.style.display = 'none'; };

            function readMouse(e, spin) {
                const rect = canvas.getBoundingClientRect();
                const dx = e.clientX - rect.left - c, dy = e.clientY - rect.top - c;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const screenAngle = wrap360(Math.atan2(dy, dx) * 180 / Math.PI);
                return {
                    inRing: Math.abs(dist - wheelR) <= trial.wheel_thickness / 2 + 12,
                    screenAngle,
                    colorDeg: Math.round(wrap360(screenAngle - spin)) % 360,
                };
            }

            let handlers = null;
            function activateWheel(spin, previewIdx, onPick) {
                const move = (e) => {
                    const r = readMouse(e, spin);
                    canvas.style.cursor = r.inRing ? 'pointer' : 'default';
                    if (trial.hover_preview) setItemColor(previewIdx, r.inRing ? r.colorDeg : null);
                };
                const click = (e) => {
                    const r = readMouse(e, spin);
                    if (!r.inRing) return;
                    deactivateWheel();
                    onPick(r);
                };
                document.addEventListener('mousemove', move);
                canvas.addEventListener('click', click);
                handlers = { move, click };
            }
            function deactivateWheel() {
                if (!handlers) return;
                document.removeEventListener('mousemove', handlers.move);
                canvas.removeEventListener('click', handlers.click);
                canvas.style.cursor = 'default';
                handlers = null;
            }

            /* ---------- cue arrow ---------- */
            function drawArrow(i) {
                const a = itemPos[i].a;
                const r0 = 18, r1 = trial.radius - trial.item_size / 2 - 14;
                const x0 = c + r0 * Math.cos(a), y0 = c + r0 * Math.sin(a);
                const x1 = c + r1 * Math.cos(a), y1 = c + r1 * Math.sin(a);
                const h = 12, w = 8;
                const bx = x1 - h * Math.cos(a), by = y1 - h * Math.sin(a);
                const px = -Math.sin(a), py = Math.cos(a);
                svg.innerHTML = `
                    <line x1="${x0}" y1="${y0}" x2="${bx}" y2="${by}" stroke="#111" stroke-width="4" stroke-linecap="round"/>
                    <polygon points="${x1},${y1} ${bx + w * px},${by + w * py} ${bx - w * px},${by - w * py}" fill="#111"/>`;
            }
            const clearArrow = () => { svg.innerHTML = ''; };

            /* ---------- trial flow ---------- */
            const refreshLog = [];
            let arrayOnset = null;

            const showArray = () => {
                for (let i = 0; i < n; i++) setItemColor(i, colors[i]);
                arrayOnset = performance.now();
                api.setTimeout(hideArray, trial.display_time);
            };

            const hideArray = () => {
                for (let i = 0; i < n; i++) setItemColor(i, null);
                api.setTimeout(() => runCue(0), trial.pre_cue_delay);
            };

            const runCue = (step) => {
                if (step >= seq.length) { api.setTimeout(showProbe, trial.post_cue_delay); return; }
                const idx = seq[step];
                const rec = {
                    step: step + 1, cued_index: idx, cued_color: colors[idx],
                    wheel_spin: null, reported_color: null, error: null, rt: null,
                };
                drawArrow(idx);
                const onset = performance.now();

                if (physical || trial.show_wheel_in_mental) {
                    rec.wheel_spin = randSpin();
                    drawWheel(rec.wheel_spin);
                }
                if (physical) {
                    activateWheel(rec.wheel_spin, idx, (r) => {
                        rec.rt = performance.now() - onset;
                        rec.reported_color = r.colorDeg;
                        rec.error = circErr(r.colorDeg, colors[idx]);
                        setItemColor(idx, null);
                        drawMarker(r.screenAngle, 3, '#111');   // lock in: wheel stays up until the step ends
                    });
                }
                refreshLog.push(rec);

                api.setTimeout(() => {
                    deactivateWheel();
                    setItemColor(idx, null);
                    clearArrow();
                    hideWheel();
                    if (step + 1 < seq.length) api.setTimeout(() => runCue(step + 1), trial.inter_cue_interval);
                    else runCue(step + 1);
                }, trial.cue_duration);
            };

            let probeSpin = null, probeOnset = null, probeDone = false;
            let probeReported = null, probeError = null, probeRT = null, probeTimedOut = false;

            const showProbe = () => {
                probeSpin = randSpin();
                drawWheel(probeSpin);
                item(target).classList.add('probed');
                probeOnset = performance.now();
                activateWheel(probeSpin, target, (r) => finishProbe(r));
                fix.style.fontSize = '10px';
                fix.innerHTML = 'Report the probed color';
                if (trial.probe_max_rt) {
                    api.setTimeout(() => { deactivateWheel(); finishProbe(null); }, trial.probe_max_rt);
                }
            };

            const finishProbe = (r) => {
                if (probeDone) return;
                probeDone = true;
                api.clearAllTimeouts();
                if (r) {
                    probeRT = performance.now() - probeOnset;
                    probeReported = r.colorDeg;
                    probeError = circErr(r.colorDeg, colors[target]);
                } else {
                    probeTimedOut = true;
                }
                if (trial.feedback) {
                    setItemColor(target, colors[target]);
                    drawMarker(wrap360(colors[target] + probeSpin), 5, '#111');
                    if (r) drawMarker(r.screenAngle, 2, '#777');
                    fix.style.fontSize = '16px';
                    fix.innerHTML = r ? `You were off by<br>${Math.abs(probeError)} degrees.` : 'Too slow!';
                    api.setTimeout(endTrial, 1500);
                } else {
                    api.setTimeout(endTrial, 100);
                }
            };

            const endTrial = () => {
                deactivateWheel();
                api.clearAllTimeouts();
                const counts = Array(n).fill(0);
                seq.forEach(i => counts[i]++);
                const targetSteps = seq.map((v, i) => (v === target ? i + 1 : null)).filter(v => v !== null);
                const answered = refreshLog.filter(s => s.reported_color !== null);

                const data = {
                    refresh_mode: trial.refresh_mode,
                    block_label: trial.block_label,
                    is_practice: trial.is_practice,
                    set_size: n,
                    item_colors: colors,
                    target_index: target,
                    target_color: colors[target],
                    cue_sequence: seq,
                    cue_counts: counts,
                    target_refresh_count: counts[target],
                    target_cue_steps: targetSteps,
                    target_last_cue_step: targetSteps.length ? Math.max(...targetSteps) : null,
                    n_cue_steps: seq.length,
                    refresh_responses: refreshLog,
                    refresh_n_missed: physical ? refreshLog.length - answered.length : null,
                    refresh_mean_abs_error: physical && answered.length
                        ? answered.reduce((s, x) => s + Math.abs(x.error), 0) / answered.length : null,
                    probe_wheel_spin: probeSpin,
                    reported_color: probeReported,
                    error: probeError,
                    abs_error: probeError === null ? null : Math.abs(probeError),
                    probe_rt: probeRT,
                    probe_timed_out: probeTimedOut,
                    display_time: trial.display_time,
                    pre_cue_delay: trial.pre_cue_delay,
                    cue_duration: trial.cue_duration,
                    inter_cue_interval: trial.inter_cue_interval,
                    post_cue_delay: trial.post_cue_delay,
                    show_wheel_in_mental: trial.show_wheel_in_mental,
                    hover_preview: trial.hover_preview,
                };
                display_element.innerHTML = '';
                jsP.finishTrial(data);
            };

            api.setTimeout(showArray, trial.iti);
        }
    }

    InstructedRefreshingPlugin.info = info;
    return InstructedRefreshingPlugin;
})(jsPsychModule);
