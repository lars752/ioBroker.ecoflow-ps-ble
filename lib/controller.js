'use strict';

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
     * @param {boolean} [o.hold] true (Standard) = Sollwert aktiv halten (Soll/Ist-Abgleich, Re-Assert);
     *                          false = nur schreiben, wenn der Sollwert gesetzt wurde (Durchreichen)
     * @param {number} [o.maxAttempts] ohne hold: maximale Schreibversuche je Sollwert, bis er vom Geraet bestaetigt ist (Standard 5)
     * @param {() => number} [o.now]
     */
    constructor(o) {
        this.minWatts = o.minWatts;
        this.maxWatts = o.maxWatts;
        this.toleranceW = o.toleranceW;
        this.graceMs = o.graceMs;
        this.hold = o.hold !== false;
        this.pending = false; // gesetzter, noch nicht auf dem Geraet bestaetigter Sollwert (nur ohne hold)
        this.maxAttempts = o.maxAttempts > 0 ? o.maxAttempts : 5;
        this.attempts = 0; // Schreibversuche des aktuellen Sollwerts (nur ohne hold)
        this.tryMs = -Infinity; // Zeitpunkt des letzten Versuchs (nur ohne hold)
        this.gaveUp = false; // alle Versuche ausgeschoepft, Geraet hat den Wert nie uebernommen (nur ohne hold)
        this.now = o.now || Date.now;
        this.target = o.startWatts >= 0 ? this.normalize(o.startWatts) : null;
        this.lastWritten = null;
        this.lastWriteMs = -Infinity; // vor dem ersten Schreiben keine Karenz
    }

    /** auf ganze Watt runden (kaufmaennisch) und auf minWatts..maxWatts begrenzen */
    normalize(w) {
        return Math.min(this.maxWatts, Math.max(this.minWatts, Math.round(w)));
    }

    /** Neuen Sollwert uebernehmen; liefert den tatsaechlich verwendeten Wert */
    setTarget(w) {
        this.target = this.normalize(w);
        this.pending = true;
        this.attempts = 0;
        this.tryMs = -Infinity;
        this.gaveUp = false;
        return this.target;
    }

    /** Versuchszaehler zuruecksetzen (z. B. nach einem Reconnect), der Sollwert bleibt offen */
    retry() {
        this.attempts = 0;
        this.tryMs = -Infinity;
        this.gaveUp = false;
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
        if (!this.hold) {
            // Durchreichen: nur einen neu gesetzten Sollwert schreiben, nichts nachfuehren.
            // Der Sollwert bleibt aber offen, bis das Geraet ihn meldet: ein verlorener oder ignorierter
            // Schreibzugriff wird (nach der Karenzzeit, hoechstens maxAttempts mal) wiederholt.
            if (!this.pending) {
                return null;
            }
            if (permWatts === this.target) {
                this.pending = false; // Geraet hat den Wert
                this.attempts = 0;
                this.gaveUp = false;
                return null;
            }
            if (this.attempts >= this.maxAttempts) {
                this.gaveUp = true;
                return null;
            }
            if (this.now() - this.tryMs < this.graceMs) {
                return null; // auf die Bestaetigung durch den naechsten Heartbeat warten
            }
            return this.target;
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
        if (this.hold) {
            if (w === this.target) {
                this.pending = false;
            }
        } else {
            this.attempts++;
            this.tryMs = this.lastWriteMs;
        }
    }
}

module.exports = { SetpointController };
