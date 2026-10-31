'use strict';
/**
 * Sensor-Tabelle: Feldnummer des inverter_heartbeat + Divisor.
 * ACHTUNG: Inverter input/100 & op/10 ist UMGEKEHRT zu PV/LLC (input/10 & op/100).
 *
 * key    -> State-ID unter <geraet>.inverter_heartbeat. (Namen wie im Adapter ioBroker.ecoflow-mqtt von foxthefox)
 * hidden -> wird nur angelegt, wenn "alle Sensoren" aktiviert ist
 * kind   -> 'bool' fuer Ein/Aus-Werte, sonst Zahl
 */
const SENSORS = [
    // --- Inverter ---
    { key: 'invInputVolt', name: 'Inverter Eingangsspannung', field: 35, divisor: 100, unit: 'V', role: 'value.voltage' },
    { key: 'invOpVolt', name: 'Inverter Betriebsspannung', field: 36, divisor: 10, unit: 'V', role: 'value.voltage' },
    { key: 'invOutputCur', name: 'Inverter Ausgangsstrom', field: 37, divisor: 1000, unit: 'A', role: 'value.current' },
    { key: 'invOutputWatts', name: 'Inverter Ausgang', field: 38, divisor: 10, unit: 'W', role: 'value.power' },
    { key: 'invTemp', name: 'Inverter Temperatur', field: 39, divisor: 10, unit: '°C', role: 'value.temperature', hidden: true },
    { key: 'invFreq', name: 'Inverter Frequenz', field: 40, divisor: 10, unit: 'Hz', role: 'value' },
    { key: 'invDcCur', name: 'Inverter DC-Strom', field: 41, divisor: 1000, unit: 'A', role: 'value.current' },
    // --- PV1 ---
    { key: 'pv1InputVolt', name: 'PV1 Eingangsspannung', field: 16, divisor: 10, unit: 'V', role: 'value.voltage' },
    { key: 'pv1OpVolt', name: 'PV1 Betriebsspannung', field: 17, divisor: 100, unit: 'V', role: 'value.voltage' },
    { key: 'pv1InputCur', name: 'PV1 Strom', field: 18, divisor: 10, unit: 'A', role: 'value.current' },
    { key: 'pv1InputWatts', name: 'PV1 Leistung', field: 19, divisor: 10, unit: 'W', role: 'value.power' },
    { key: 'pv1Temp', name: 'PV1 Temperatur', field: 20, divisor: 10, unit: '°C', role: 'value.temperature' },
    // --- PV2 ---
    { key: 'pv2InputVolt', name: 'PV2 Eingangsspannung', field: 21, divisor: 10, unit: 'V', role: 'value.voltage' },
    { key: 'pv2OpVolt', name: 'PV2 Betriebsspannung', field: 22, divisor: 100, unit: 'V', role: 'value.voltage' },
    { key: 'pv2InputCur', name: 'PV2 Strom', field: 23, divisor: 10, unit: 'A', role: 'value.current' },
    { key: 'pv2InputWatts', name: 'PV2 Leistung', field: 24, divisor: 10, unit: 'W', role: 'value.power' },
    { key: 'pv2Temp', name: 'PV2 Temperatur', field: 25, divisor: 10, unit: '°C', role: 'value.temperature' },
    // --- LLC ---
    { key: 'llcInputVolt', name: 'LLC Eingangsspannung', field: 32, divisor: 10, unit: 'V', role: 'value.voltage' },
    { key: 'llcOpVolt', name: 'LLC Betriebsspannung', field: 33, divisor: 100, unit: 'V', role: 'value.voltage' },
    { key: 'llcTemp', name: 'LLC Temperatur', field: 34, divisor: 10, unit: '°C', role: 'value.temperature' },
    // --- Leistung / Batterie / sonstiges ---
    { key: 'permanentWatts', name: 'Permanent Watts (Ist-Sollwert im Gerät)', field: 48, divisor: 10, unit: 'W', role: 'value.power' },
    { key: 'ratedPower', name: 'Nennleistung', field: 58, divisor: 1, unit: 'W', role: 'value.power' },
    // Feld 29, vorzeichenbehaftet: +/- = Fluss zur/von Batterie
    { key: 'batInputWatts', name: 'Batterie Leistung', field: 29, divisor: 10, unit: 'W', role: 'value.power' },
    // Feld 31, ganzzahlig in %
    { key: 'batSoc', name: 'Batterie SoC', field: 31, divisor: 1, unit: '%', role: 'value.battery' },
    { key: 'heartbeatFrequency', name: 'Heartbeat Frequenz', field: 57, divisor: 1, unit: 'Hz', role: 'value' },
    // --- Status / Roh-Codes ---
    { key: 'invOnOff', name: 'Inverter On/Off', field: 53, divisor: 1, kind: 'bool', role: 'indicator' },
    { key: 'invStatus', name: 'Inverter Status', field: 15, divisor: 1, role: 'value' },
    { key: 'invRelayStatus', name: 'Inverter Relay Status', field: 43, divisor: 1, role: 'value' },
    // Inverter meldet Pack-Typ: 2 = DP verbunden/identifiziert
    { key: 'bpType', name: 'Battery Pack Type', field: 42, divisor: 1, role: 'value' },
    { key: 'pv1Status', name: 'PV1 Status', field: 11, divisor: 1, role: 'value' },
    { key: 'pv1RelayStatus', name: 'PV1 Relay Status', field: 44, divisor: 1, role: 'value' },
    { key: 'pv2Status', name: 'PV2 Status', field: 12, divisor: 1, role: 'value' },
    { key: 'pv2RelayStatus', name: 'PV2 Relay Status', field: 45, divisor: 1, role: 'value' },
    { key: 'llcStatus', name: 'LLC Status', field: 14, divisor: 1, role: 'value' },
    { key: 'supplyPriority', name: 'Supply Priority', field: 50, divisor: 1, role: 'value' },
    { key: 'installCountry', name: 'Installation Country', field: 46, divisor: 1, role: 'value', hidden: true },
    { key: 'installTown', name: 'Installation Town', field: 47, divisor: 1, role: 'value', hidden: true },
    // --- Error/Warning Codes ---
    { key: 'invErrCode', name: 'Inverter Error Code', field: 1, divisor: 1, role: 'value' },
    { key: 'invWarnCode', name: 'Inverter Warning Code', field: 3, divisor: 1, role: 'value' },
    { key: 'pv1ErrCode', name: 'PV1 Error Code', field: 2, divisor: 1, role: 'value' },
    { key: 'pv1WarnCode', name: 'PV1 Warning Code', field: 4, divisor: 1, role: 'value' },
    { key: 'pv2ErrCode', name: 'PV2 Error Code', field: 5, divisor: 1, role: 'value' },
    { key: 'pv2WarningCode', name: 'PV2 Warning Code', field: 6, divisor: 1, role: 'value' },
    { key: 'llcErrCode', name: 'LLC Error Code', field: 9, divisor: 1, role: 'value' },
    { key: 'llcWarningCode', name: 'LLC Warning Code', field: 10, divisor: 1, role: 'value' },
    { key: 'wirelessErrCode', name: 'Wireless Error Code', field: 54, divisor: 1, role: 'value' },
    { key: 'wirelessWarnCode', name: 'Wireless Warning Code', field: 55, divisor: 1, role: 'value' },

    // --- weitere Felder des inverter_heartbeat (Feldnummern aus dem PowerStream-Protokoll) ---
    { key: 'batErrCode', name: 'Battery Error Code', field: 7, divisor: 1, role: 'value' },
    { key: 'batWarningCode', name: 'Battery Warning Code', field: 8, divisor: 1, role: 'value' },
    { key: 'batStatus', name: 'Battery Status', field: 13, divisor: 1, role: 'value' },
    { key: 'batInputVolt', name: 'Batterie Eingangsspannung', field: 26, divisor: 10, unit: 'V', role: 'value.voltage' },
    { key: 'batOpVolt', name: 'Batterie Betriebsspannung', field: 27, divisor: 10, unit: 'V', role: 'value.voltage' },
    { key: 'batInputCur', name: 'Batterie Strom', field: 28, divisor: 1000, unit: 'A', role: 'value.current' },
    { key: 'batTemp', name: 'Batterie Temperatur', field: 30, divisor: 10, unit: '°C', role: 'value.temperature' },
    { key: 'dynamicWatts', name: 'Dynamic Power (Smart-Plug-Last)', field: 49, divisor: 10, unit: 'W', role: 'value.power' },
    { key: 'lowerLimit', name: 'Batterie SoC Untergrenze', field: 51, divisor: 1, unit: '%', role: 'value' },
    { key: 'upperLimit', name: 'Batterie SoC Obergrenze', field: 52, divisor: 1, unit: '%', role: 'value' },
    // ohne Batterie meldet das Geraet 143999/144000 (Platzhalter)
    { key: 'batChargingTime', name: 'Batterie Restladezeit', field: 59, divisor: 1, unit: 'min', role: 'value' },
    { key: 'batDischargingTime', name: 'Batterie Restentladezeit', field: 60, divisor: 1, unit: 'min', role: 'value' },
];

/** Zustands-Channel der Messwerte (wie im Adapter ioBroker.ecoflow-mqtt) */
const HB_CHANNEL = 'inverter_heartbeat';

/** Alle Feldnummern, die der Adapter kennt (Sensoren + Steuer-Rueckmeldung) */
function knownFields() {
    const set = new Set(SENSORS.map(x => x.field));
    set.add(56); // Helligkeit -> control.brightness
    return set;
}

/** Feldnummern, die auch fuer die Steuer-Rueckmeldung gebraucht werden */
const FIELD = { PERM: 48, INV_OUT: 38, BRIGHT: 56, SUPPLY: 50 };

function decimalsFor(divisor) {
    return divisor === 1000 ? 3 : divisor === 100 ? 2 : divisor === 10 ? 1 : 0;
}

/** Rohwert -> Anzeigewert (proto3-Regel: fehlendes Feld = 0) */
function scaleValue(sensor, raw) {
    if (sensor.kind === 'bool') {
        return raw !== 0;
    }
    if (sensor.divisor === 1) {
        return raw;
    }
    return Number((raw / sensor.divisor).toFixed(decimalsFor(sensor.divisor)));
}

module.exports = { HB_CHANNEL, knownFields, SENSORS, FIELD, scaleValue, decimalsFor };
