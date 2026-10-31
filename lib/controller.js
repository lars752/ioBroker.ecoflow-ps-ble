'use strict';

/** Kaufmaennische Rundung auf 5 W */
function roundTo5(w) {
    if (w < 0) {
        w = 0;
    }
    return Math.floor((w + 2) / 5) * 5;
}

/**
 * Sollwert-Regelung mit Write-on-Change:
 * permanent_watts wird nur geschrieben, wenn sich der Sollwert aendert ODER der Ist-Wert
 * (Feld 48) um >= tolerance vom Soll abweicht. Kein periodisches Rewrite -> schont den
 * Flash des PowerStream. Re-Assert wird ueber eine Karenzzeit gedrosselt.
 *
 * Ein "neuer" Sollwert gilt erst als geaendert, wenn schon einmal ein Wert geschrieben wurde.
 * Beim Start (noch nichts geschrieben) entscheidet allein der Soll/Ist-Vergleich -> kein
 * unnoetiger Schreibzugriff, wenn Ist == Soll. "Zuletzt geschrieben" wird erst nach
 * erfolgreichem Schreiben gemerkt.
 */
class SetpointController {
    /**
     * @param {object} o
     * @param {number} o.minWatts
     * @param {number} o.maxWatts
     * @param {number} o.startWatts  <0 = kein Startwert (erst schreiben, wenn ein Sollwert gesetzt wurde)
     * @param {number} o.toleranceW
     * @param {number} o.graceMs
     * @param {() => number} [o.now]
     */
    constructor(o) {
        this.minWatts = o.minWatts;
        this.maxWatts = o.maxWatts;
        this.toleranceW = o.toleranceW;
        this.graceMs = o.graceMs;
        this.now = o.now || Date.now;
        this.target = o.startWatts >= 0 ? this.normalize(o.startWatts) : null;
        this.lastWritten = null;
        this.lastWriteMs = -Infinity; // vor dem ersten Schreiben keine Karenz
    }

    /** begrenzen -> auf 5 W runden -> erneut begrenzen */
    normalize(w) {
        const clamp = v => Math.min(this.maxWatts, Math.max(this.minWatts, v));
        return clamp(roundTo5(clamp(Math.round(w))));
    }

    /** Neuen Sollwert uebernehmen; liefert den tatsaechlich verwendeten Wert */
    setTarget(w) {
        this.target = this.normalize(w);
        return this.target;
    }

    /**
     * Entscheidet, ob jetzt geschrieben werden muss.
     *
     * @param {number|null} permWatts Ist-Wert (Feld 48) oder null, wenn unbekannt
     * @returns {number|null} zu schreibender Wert oder null
     */
    decide(permWatts) {
        if (this.target === null || permWatts === null || permWatts < 0) {
            return null;
        }
        const changed = this.lastWritten !== null && this.target !== this.lastWritten;
        const mismatch = Math.abs(permWatts - this.target) >= this.toleranceW;
        if (!changed && !mismatch) {
            return null;
        }
        if (!changed && this.now() - this.lastWriteMs < this.graceMs) {
            return null;
        }
        return this.target;
    }

    /** Nach erfolgreichem Schreiben aufrufen */
    markWritten(w) {
        this.lastWritten = w;
        this.lastWriteMs = this.now();
    }
}

module.exports = { SetpointController, roundTo5 };
