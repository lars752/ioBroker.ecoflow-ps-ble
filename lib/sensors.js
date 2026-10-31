'use strict';
/**
 * Sensor-Tabelle: 1:1 aus der ESP-Firmware (Feldnummer des inverter_heartbeat + Divisor).
 * ACHTUNG: Inverter input/100 & op/10 ist UMGEKEHRT zu PV/LLC (input/10 & op/100).
 *
 * key    -> State-ID unter <geraet>.telemetry.
 * hidden -> wird nur angelegt, wenn "alle Sensoren" aktiviert ist (in HA: enabled_by_default:false)
 * kind   -> 'bool' fuer Ein/Aus-Werte, sonst Zahl
 */
const SENSORS = [
    // --- Inverter ---
    { key: 'inv_volt_in', name: 'Inverter Eingangsspannung', field: 35, divisor: 100, unit: 'V', role: 'value.voltage' },
    { key: 'inv_volt_op', name: 'Inverter Betriebsspannung', field: 36, divisor: 10, unit: 'V', role: 'value.voltage' },
    { key: 'inv_cur_out', name: 'Inverter Ausgangsstrom', field: 37, divisor: 1000, unit: 'A', role: 'value.current' },
    { key: 'inv_output_watts', name: 'Inverter Ausgang', field: 38, divisor: 10, unit: 'W', role: 'value.power' },
    { key: 'inv_temp', name: 'Inverter Temperatur', field: 39, divisor: 10, unit: '°C', role: 'value.temperature', hidden: true },
    { key: 'inv_freq', name: 'Inverter Frequenz', field: 40, divisor: 10, unit: 'Hz', role: 'value' },
    { key: 'inv_dc_cur', name: 'Inverter DC-Strom', field: 41, divisor: 1000, unit: 'A', role: 'value.current' },
    // --- PV1 ---
    { key: 'pv1_volt_in', name: 'PV1 Eingangsspannung', field: 16, divisor: 10, unit: 'V', role: 'value.voltage' },
    { key: 'pv1_volt_op', name: 'PV1 Betriebsspannung', field: 17, divisor: 100, unit: 'V', role: 'value.voltage' },
    { key: 'pv1_cur', name: 'PV1 Strom', field: 18, divisor: 10, unit: 'A', role: 'value.current' },
    { key: 'pv1_watts', name: 'PV1 Leistung', field: 19, divisor: 10, unit: 'W', role: 'value.power' },
    { key: 'pv1_temp', name: 'PV1 Temperatur', field: 20, divisor: 10, unit: '°C', role: 'value.temperature' },
    // --- PV2 ---
    { key: 'pv2_volt_in', name: 'PV2 Eingangsspannung', field: 21, divisor: 10, unit: 'V', role: 'value.voltage' },
    { key: 'pv2_volt_op', name: 'PV2 Betriebsspannung', field: 22, divisor: 100, unit: 'V', role: 'value.voltage' },
    { key: 'pv2_cur', name: 'PV2 Strom', field: 23, divisor: 10, unit: 'A', role: 'value.current' },
    { key: 'pv2_watts', name: 'PV2 Leistung', field: 24, divisor: 10, unit: 'W', role: 'value.power' },
    { key: 'pv2_temp', name: 'PV2 Temperatur', field: 25, divisor: 10, unit: '°C', role: 'value.temperature' },
    // --- LLC ---
    { key: 'llc_volt_in', name: 'LLC Eingangsspannung', field: 32, divisor: 10, unit: 'V', role: 'value.voltage' },
    { key: 'llc_volt_op', name: 'LLC Betriebsspannung', field: 33, divisor: 100, unit: 'V', role: 'value.voltage' },
    { key: 'llc_temp', name: 'LLC Temperatur', field: 34, divisor: 10, unit: '°C', role: 'value.temperature' },
    // --- Leistung / Batterie / sonstiges ---
    { key: 'permanent_watts', name: 'Permanent Watts (Ist-Sollwert im Gerät)', field: 48, divisor: 10, unit: 'W', role: 'value.power' },
    { key: 'rated_power', name: 'Nennleistung', field: 58, divisor: 10, unit: 'W', role: 'value.power' },
    // Feld 29, vorzeichenbehaftet: +/- = Fluss zur/von Batterie
    { key: 'bat_input_watts', name: 'Batterie Leistung', field: 29, divisor: 10, unit: 'W', role: 'value.power' },
    // Z-01 "Add Battery SoC Sensor": Feld 31, ganzzahlig in %
    { key: 'bat_soc', name: 'Batterie SoC', field: 31, divisor: 1, unit: '%', role: 'value.battery' },
    { key: 'hb_freq', name: 'Heartbeat Frequenz', field: 57, divisor: 1, unit: 's', role: 'value' },
    // --- Status / Roh-Codes ---
    { key: 'inv_onoff', name: 'Inverter On/Off', field: 53, divisor: 1, kind: 'bool', role: 'indicator' },
    { key: 'inv_status', name: 'Inverter Status', field: 15, divisor: 1, role: 'value' },
    { key: 'inv_relay', name: 'Inverter Relay Status', field: 43, divisor: 1, role: 'value' },
    // Inverter meldet Pack-Typ: 2 = DP verbunden/identifiziert
    { key: 'bp_type', name: 'Battery Pack Type', field: 42, divisor: 1, role: 'value' },
    { key: 'pv1_status', name: 'PV1 Status', field: 11, divisor: 1, role: 'value' },
    { key: 'pv1_relay', name: 'PV1 Relay Status', field: 44, divisor: 1, role: 'value' },
    { key: 'pv2_status', name: 'PV2 Status', field: 12, divisor: 1, role: 'value' },
    { key: 'pv2_relay', name: 'PV2 Relay Status', field: 45, divisor: 1, role: 'value' },
    { key: 'llc_status', name: 'LLC Status', field: 14, divisor: 1, role: 'value' },
    { key: 'supply_prio', name: 'Supply Priority', field: 50, divisor: 1, role: 'value' },
    { key: 'install_ctry', name: 'Installation Country', field: 46, divisor: 1, role: 'value', hidden: true },
    { key: 'install_town', name: 'Installation Town', field: 47, divisor: 1, role: 'value', hidden: true },
    // --- Error/Warning Codes ---
    { key: 'inv_err', name: 'Inverter Error Code', field: 1, divisor: 1, role: 'value' },
    { key: 'inv_warn', name: 'Inverter Warning Code', field: 3, divisor: 1, role: 'value' },
    { key: 'pv1_err', name: 'PV1 Error Code', field: 2, divisor: 1, role: 'value' },
    { key: 'pv1_warn', name: 'PV1 Warning Code', field: 4, divisor: 1, role: 'value' },
    { key: 'pv2_err', name: 'PV2 Error Code', field: 5, divisor: 1, role: 'value' },
    { key: 'pv2_warn', name: 'PV2 Warning Code', field: 6, divisor: 1, role: 'value' },
    { key: 'llc_err', name: 'LLC Error Code', field: 9, divisor: 1, role: 'value' },
    { key: 'llc_warn', name: 'LLC Warning Code', field: 10, divisor: 1, role: 'value' },
    { key: 'wl_err', name: 'Wireless Error Code', field: 54, divisor: 1, role: 'value' },
    { key: 'wl_warn', name: 'Wireless Warning Code', field: 55, divisor: 1, role: 'value' },
];

/** Feldnummern, die auch fuer die Steuer-Rueckmeldung gebraucht werden */
const FIELD = { PERM: 48, INV_OUT: 38, BRIGHT: 56, SUPPLY: 50 };

function decimalsFor(divisor) {
    return divisor === 1000 ? 3 : divisor === 100 ? 2 : divisor === 10 ? 1 : 0;
}

/** Rohwert -> Anzeigewert (proto3-Regel der Firmware: fehlendes Feld = 0) */
function scaleValue(sensor, raw) {
    if (sensor.kind === 'bool') {
        return raw !== 0;
    }
    if (sensor.divisor === 1) {
        return raw;
    }
    return Number((raw / sensor.divisor).toFixed(decimalsFor(sensor.divisor)));
}

module.exports = { SENSORS, FIELD, scaleValue, decimalsFor };
