import Toybox.Activity;
import Toybox.ActivityRecording;
import Toybox.Attention;
import Toybox.BluetoothLowEnergy;
import Toybox.FitContributor;
import Toybox.Lang;
import Toybox.Math;
import Toybox.System;
import Toybox.Timer;
import Toybox.WatchUi;

const PAGE_COUNT = 4;

// If the board isn't found within this long, it's most likely because a
// phone (with the official Onewheel app) already holds the board's one
// BLE connection slot -- these boards stop advertising entirely once
// connected to anything. See PROTOCOL.md / README.md for why the watch
// and phone can't both be connected at the same time.
const SCAN_TIMEOUT_MS = 30000;

// GT's tire is 11.5" x 6.5"-6.5" per Future Motion / TrailWheel specs --
// diameter, not circumference. This hasn't been sanity-checked against GPS
// speed yet, so treat displayed mph as an estimate until that's done.
const ONEWHEEL_WHEEL_DIAMETER_INCHES = 11.5;
const INCHES_PER_MILE = 63360.0;

// Owns the whole BLE lifecycle for talking to the Onewheel: scan, pair,
// discover characteristics, unlock, subscribe to telemetry, and keep the
// unlock alive. Doubles as the BleDelegate since this app only ever talks
// to one device at a time -- no need for the weak-reference model/view
// separation the more general Garmin BLE samples use. Also owns the
// activity-recording session so a ride gets a real GPS-tracked FIT file,
// with board telemetry alongside it as custom fields.
class OnewheelConnection extends BluetoothLowEnergy.BleDelegate {

    var status as String = "Scanning...";
    var lastError as String?;
    // Set when a scan runs past SCAN_TIMEOUT_MS without finding the board.
    // The status line stays short (the very top of a round display has
    // almost no width to work with); the full explanation is shown lower
    // down on the Ride page instead, where there's actually room for it.
    var scanTimedOut as Boolean = false;

    var batteryLevel as Number?;
    var speedRpm as Number?;
    var speedMph as Float?;
    var ridingMode as Number?;
    var safetyHeadroom as Number?;
    // motor_controller_temp is two independent signed-byte Celsius readings,
    // not one 16-bit number -- confirmed via FutureMotion's own decompiled
    // app (b2.n.a() splits it into two ints, fed to two separate setters).
    // Which physical sensor each corresponds to isn't labeled anywhere we've
    // found -- shown as two values rather than guessing/averaging them.
    var motorTempAF as Number?;
    var motorTempBF as Number?;
    // battery_low_temp -- same two-independent-signed-byte-Celsius shape as
    // motor_controller_temp, confirmed against a live GT. See PROTOCOL.md.
    var batteryTempAF as Number?;
    var batteryTempBF as Number?;
    var boardStatus as Number?;
    // Raw board odometer units -- not yet calibrated to real miles, same
    // caveat as wheel RPM->mph. See PROTOCOL.md.
    var tripOdometer as Number?;
    var lifeOdometer as Number?;
    // Diagnostic only, for now -- checking whether these actually update
    // live while riding, or read back empty like battery_voltage/amperage.
    // See CONTRIBUTING.md/PROTOCOL.md.
    var tripAmpHours as Number?;
    var tripRegenAmpHours as Number?;

    // Our own distance, integrated from wheel RPM->mph over time (not the
    // board's ambiguous raw odometer -- see PROTOCOL.md). Same "(est.)"
    // caveat as speed, since it's built on the same unverified wheel
    // diameter assumption.
    var distanceMilesThisRide as Float = 0.0;
    // Extrapolated from (distance so far) / (battery %% consumed so far),
    // compared against battery level *at ride start*. Null until enough
    // battery has actually been consumed to compute a rate.
    var estimatedRangeMiles as Float?;

    var currentPage as Number = 0;

    // True from the moment the halfway-battery threshold is crossed until
    // the next recording starts. Compared against battery level *at the
    // start of this ride*, not a flat 50% of the full pack.
    var halfwayWarningActive as Boolean = false;

    private var _device as Device?;
    private var _uartWriteChar as Characteristic?;
    private var _pendingCccdChars as Array<Characteristic> = [];
    private var _keepaliveTimer as Timer.Timer?;
    private var _scanTimeoutTimer as Timer.Timer?;

    private var _session as Session?;
    private var _speedField as Field?;
    private var _batteryField as Field?;
    private var _motorTempAField as Field?;
    private var _motorTempBField as Field?;
    private var _safetyHeadroomField as Field?;

    private var _startingBatteryLevel as Number?;
    private var _lastSpeedTimestampMs as Number?;

    public function initialize() {
        BleDelegate.initialize();
        OnewheelProfile.registerProfile();
    }

    public function startScan() as Void {
        status = "Scanning...";
        scanTimedOut = false;
        WatchUi.requestUpdate();
        BluetoothLowEnergy.setScanState(BluetoothLowEnergy.SCAN_STATE_SCANNING);

        if (_scanTimeoutTimer != null) {
            _scanTimeoutTimer.stop();
        }
        _scanTimeoutTimer = new Timer.Timer();
        _scanTimeoutTimer.start(method(:onScanTimeout), SCAN_TIMEOUT_MS, false);
    }

    // Only fires if we're still scanning by then -- if a board was found in
    // the meantime, this is a no-op (the timer gets stopped on success, but
    // there's a small window where both could race).
    public function onScanTimeout() as Void {
        if (status.equals("Scanning...")) {
            scanTimedOut = true;
            WatchUi.requestUpdate();
        }
    }

    // Page navigation (hooked up to the physical Up/Down buttons)

    public function nextPage() as Void {
        currentPage = (currentPage + 1) % PAGE_COUNT;
        WatchUi.requestUpdate();
    }

    public function previousPage() as Void {
        currentPage = (currentPage - 1 + PAGE_COUNT) % PAGE_COUNT;
        WatchUi.requestUpdate();
    }

    // Recording control (hooked up to the physical Start/Stop button)

    public function isRecording() as Boolean {
        return _session != null && _session.isRecording();
    }

    public function toggleRecording() as Void {
        try {
            if (isRecording()) {
                stopRecording();
            } else {
                startRecording();
            }
            lastError = null;
        } catch (e instanceof Lang.Exception) {
            lastError = e.getErrorMessage();
        }
        WatchUi.requestUpdate();
    }

    // Safety net so an in-progress recording isn't lost if the app closes
    // (e.g. system-initiated) without the user pressing Start/Stop first.
    public function saveIfRecording() as Void {
        if (isRecording()) {
            stopRecording();
        }
    }

    private function startRecording() as Void {
        // Sport left generic for now -- no Onewheel-specific sport type
        // exists, worth revisiting once we see how Garmin Connect renders it.
        _session = ActivityRecording.createSession({
            :name => "Onewheel",
            :sport => Activity.SPORT_GENERIC,
            :subSport => Activity.SUB_SPORT_GENERIC
        });
        _session.start();

        // Units are "raw" for wheel RPM/safety headroom because we haven't
        // calibrated those to real units yet -- see PROTOCOL.md. Battery and
        // the two motor temps are confirmed real units (% and degF).
        _speedField = _session.createField("Wheel RPM", 0, FitContributor.DATA_TYPE_UINT16, { :mesgType => FitContributor.MESG_TYPE_RECORD, :units => "rpm" });
        _batteryField = _session.createField("Board Battery", 1, FitContributor.DATA_TYPE_UINT8, { :mesgType => FitContributor.MESG_TYPE_RECORD, :units => "%" });
        _motorTempAField = _session.createField("Motor Temp A", 2, FitContributor.DATA_TYPE_SINT16, { :mesgType => FitContributor.MESG_TYPE_RECORD, :units => "degF" });
        _motorTempBField = _session.createField("Motor Temp B", 4, FitContributor.DATA_TYPE_SINT16, { :mesgType => FitContributor.MESG_TYPE_RECORD, :units => "degF" });
        _safetyHeadroomField = _session.createField("Safety Headroom (raw)", 3, FitContributor.DATA_TYPE_UINT16, { :mesgType => FitContributor.MESG_TYPE_RECORD, :units => "raw" });

        _startingBatteryLevel = batteryLevel;
        halfwayWarningActive = false;
        distanceMilesThisRide = 0.0;
        estimatedRangeMiles = null;
        _lastSpeedTimestampMs = null;

        WatchUi.requestUpdate();
    }

    private function stopRecording() as Void {
        if (_session != null && _session.isRecording()) {
            _session.stop();
            _session.save();
        }
        _session = null;
        _startingBatteryLevel = null;
        halfwayWarningActive = false;
        _speedField = null;
        _batteryField = null;
        _motorTempAField = null;
        _motorTempBField = null;
        _safetyHeadroomField = null;
        WatchUi.requestUpdate();
    }

    // BleDelegate callbacks

    public function onScanResults(scanResults as Iterator) as Void {
        for (var result = scanResults.next(); result != null; result = scanResults.next()) {
            if (!(result instanceof ScanResult)) {
                continue;
            }

            // Connect IQ's scanner doesn't reliably surface this board's
            // service UUID (see PROTOCOL.md) -- name prefix is what actually
            // works, service UUID kept as a fallback.
            var name = result.getDeviceName();
            var isOnewheel = name != null && name.toLower().find("ow") == 0;

            if (isOnewheel || containsServiceUuid(result)) {
                BluetoothLowEnergy.setScanState(BluetoothLowEnergy.SCAN_STATE_OFF);
                if (_scanTimeoutTimer != null) {
                    _scanTimeoutTimer.stop();
                    _scanTimeoutTimer = null;
                }
                status = "Connecting...";
                WatchUi.requestUpdate();
                _device = BluetoothLowEnergy.pairDevice(result);
                return;
            }
        }
    }

    public function onConnectedStateChanged(device as Device, state as BluetoothLowEnergy.ConnectionState) as Void {
        if (!device.equals(_device)) {
            return;
        }

        if (state == BluetoothLowEnergy.CONNECTION_STATE_CONNECTED) {
            status = "Discovering...";
            WatchUi.requestUpdate();
            setupCharacteristics(device);
        } else {
            status = "Disconnected, rescanning...";
            resetState();
            WatchUi.requestUpdate();
            startScan();
        }
    }

    public function onDescriptorWrite(descriptor as Descriptor, status as Status) as Void {
        if (_pendingCccdChars.size() > 0) {
            _pendingCccdChars = _pendingCccdChars.slice(1, _pendingCccdChars.size());
        }
        activateNextCccd();
    }

    public function onCharacteristicWrite(characteristic as Characteristic, status as Status) as Void {
        if (characteristic.getUuid().equals(OnewheelProfile.UART_SERIAL_WRITE_UUID)) {
            self.status = "Connected";
            WatchUi.requestUpdate();
        }
    }

    public function onCharacteristicChanged(characteristic as Characteristic, value as ByteArray) as Void {
        var uuid = characteristic.getUuid();
        var options = { :endianness => Lang.ENDIAN_BIG };

        if (uuid.equals(OnewheelProfile.BATTERY_LEVEL_UUID)) {
            batteryLevel = value.decodeNumber(Lang.NUMBER_FORMAT_UINT16, options);
            if (_batteryField != null) {
                _batteryField.setData(batteryLevel as Object);
            }
            checkHalfwayWarning();
            updateRangeEstimate();
        } else if (uuid.equals(OnewheelProfile.TRIP_ODOMETER_UUID)) {
            tripOdometer = value.decodeNumber(Lang.NUMBER_FORMAT_UINT16, options);
        } else if (uuid.equals(OnewheelProfile.LIFE_ODOMETER_UUID)) {
            lifeOdometer = value.decodeNumber(Lang.NUMBER_FORMAT_UINT16, options);
        } else if (uuid.equals(OnewheelProfile.TRIP_AMP_HOURS_UUID)) {
            tripAmpHours = value.decodeNumber(Lang.NUMBER_FORMAT_UINT16, options);
        } else if (uuid.equals(OnewheelProfile.TRIP_REGEN_AMP_HOURS_UUID)) {
            tripRegenAmpHours = value.decodeNumber(Lang.NUMBER_FORMAT_UINT16, options);
        } else if (uuid.equals(OnewheelProfile.SPEED_RPM_UUID)) {
            speedRpm = value.decodeNumber(Lang.NUMBER_FORMAT_UINT16, options);
            speedMph = rpmToMph(speedRpm as Number);
            if (_speedField != null) {
                _speedField.setData(speedRpm as Object);
            }
            accumulateDistance(speedMph as Float);
        } else if (uuid.equals(OnewheelProfile.RIDING_MODE_UUID)) {
            ridingMode = value.decodeNumber(Lang.NUMBER_FORMAT_UINT16, options);
        } else if (uuid.equals(OnewheelProfile.SAFETY_HEADROOM_UUID)) {
            safetyHeadroom = value.decodeNumber(Lang.NUMBER_FORMAT_UINT16, options);
            if (_safetyHeadroomField != null) {
                _safetyHeadroomField.setData(safetyHeadroom as Object);
            }
        } else if (uuid.equals(OnewheelProfile.MOTOR_CONTROLLER_TEMP_UUID)) {
            // Two independent signed-byte Celsius readings, not one 16-bit
            // number -- see the field comment and PROTOCOL.md.
            var tempAC = value.decodeNumber(Lang.NUMBER_FORMAT_SINT8, { :offset => 0 }) as Number;
            var tempBC = value.decodeNumber(Lang.NUMBER_FORMAT_SINT8, { :offset => 1 }) as Number;
            motorTempAF = celsiusToFahrenheit(tempAC);
            motorTempBF = celsiusToFahrenheit(tempBC);
            if (_motorTempAField != null) {
                _motorTempAField.setData(motorTempAF as Object);
            }
            if (_motorTempBField != null) {
                _motorTempBField.setData(motorTempBF as Object);
            }
        } else if (uuid.equals(OnewheelProfile.BATTERY_LOW_TEMP_UUID)) {
            var battTempAC = value.decodeNumber(Lang.NUMBER_FORMAT_SINT8, { :offset => 0 }) as Number;
            var battTempBC = value.decodeNumber(Lang.NUMBER_FORMAT_SINT8, { :offset => 1 }) as Number;
            batteryTempAF = celsiusToFahrenheit(battTempAC);
            batteryTempBF = celsiusToFahrenheit(battTempBC);
        } else if (uuid.equals(OnewheelProfile.STATUS_UUID)) {
            boardStatus = value.decodeNumber(Lang.NUMBER_FORMAT_UINT16, options);
        }

        WatchUi.requestUpdate();
    }

    // Connection setup

    private function setupCharacteristics(device as Device) as Void {
        var service = device.getService(OnewheelProfile.SERVICE_UUID);
        if (service == null) {
            status = "Service not found";
            WatchUi.requestUpdate();
            return;
        }

        _uartWriteChar = service.getCharacteristic(OnewheelProfile.UART_SERIAL_WRITE_UUID);

        _pendingCccdChars = [];
        addIfPresent(service, OnewheelProfile.BATTERY_LEVEL_UUID);
        addIfPresent(service, OnewheelProfile.SPEED_RPM_UUID);
        addIfPresent(service, OnewheelProfile.RIDING_MODE_UUID);
        addIfPresent(service, OnewheelProfile.SAFETY_HEADROOM_UUID);
        addIfPresent(service, OnewheelProfile.MOTOR_CONTROLLER_TEMP_UUID);
        addIfPresent(service, OnewheelProfile.BATTERY_LOW_TEMP_UUID);
        addIfPresent(service, OnewheelProfile.STATUS_UUID);
        addIfPresent(service, OnewheelProfile.TRIP_ODOMETER_UUID);
        addIfPresent(service, OnewheelProfile.LIFE_ODOMETER_UUID);
        addIfPresent(service, OnewheelProfile.TRIP_AMP_HOURS_UUID);
        addIfPresent(service, OnewheelProfile.TRIP_REGEN_AMP_HOURS_UUID);

        status = "Subscribing...";
        WatchUi.requestUpdate();
        activateNextCccd();
    }

    private function addIfPresent(service as Service, uuid as Uuid) as Void {
        var characteristic = service.getCharacteristic(uuid);
        if (characteristic != null) {
            _pendingCccdChars = _pendingCccdChars.add(characteristic);
        }
    }

    private function activateNextCccd() as Void {
        if (_pendingCccdChars.size() == 0) {
            sendUnlock();
            return;
        }

        var characteristic = _pendingCccdChars[0];
        var cccd = characteristic.getDescriptor(BluetoothLowEnergy.cccdUuid());
        if (cccd != null) {
            cccd.requestWrite([0x01, 0x00]b);
        } else {
            // No CCCD registered for this characteristic -- skip it.
            _pendingCccdChars = _pendingCccdChars.slice(1, _pendingCccdChars.size());
            activateNextCccd();
        }
    }

    private function sendUnlock() as Void {
        if (_uartWriteChar == null) {
            status = "uart_serial_write not found";
            WatchUi.requestUpdate();
            return;
        }

        status = "Unlocking...";
        WatchUi.requestUpdate();
        _uartWriteChar.requestWrite(OnewheelProfile.UNLOCK_RESPONSE, {});

        if (_keepaliveTimer == null) {
            _keepaliveTimer = new Timer.Timer();
            _keepaliveTimer.start(method(:onKeepaliveTimer), OnewheelProfile.KEEPALIVE_INTERVAL_MS, true);
        }
    }

    public function onKeepaliveTimer() as Void {
        if (_uartWriteChar != null) {
            _uartWriteChar.requestWrite(OnewheelProfile.UNLOCK_RESPONSE, {});
        }
        // Also keeps the on-screen clock from going stale during quiet
        // stretches with no telemetry notifications to trigger a redraw.
        WatchUi.requestUpdate();
    }

    private function resetState() as Void {
        if (_keepaliveTimer != null) {
            _keepaliveTimer.stop();
            _keepaliveTimer = null;
        }
        if (_scanTimeoutTimer != null) {
            _scanTimeoutTimer.stop();
            _scanTimeoutTimer = null;
        }
        _device = null;
        _uartWriteChar = null;
        _pendingCccdChars = [];
        batteryLevel = null;
        speedRpm = null;
        speedMph = null;
        ridingMode = null;
        safetyHeadroom = null;
        motorTempAF = null;
        motorTempBF = null;
        batteryTempAF = null;
        batteryTempBF = null;
        boardStatus = null;
        tripOdometer = null;
        lifeOdometer = null;
        tripAmpHours = null;
        tripRegenAmpHours = null;
        // Not distanceMilesThisRide/estimatedRangeMiles -- those are our own
        // accumulated ride state and shouldn't reset just because the BLE
        // link hiccuped. Do clear the timestamp so a reconnect after a gap
        // doesn't integrate a bogus huge distance jump from stale elapsed time.
        _lastSpeedTimestampMs = null;
    }

    private function containsServiceUuid(result as ScanResult) as Boolean {
        var uuids = result.getServiceUuids();
        for (var uuid = uuids.next(); uuid != null; uuid = uuids.next()) {
            if (uuid.equals(OnewheelProfile.SERVICE_UUID)) {
                return true;
            }
        }
        return false;
    }

    // Estimate only -- see the wheel diameter constant's comment. Not yet
    // sanity-checked against GPS speed.
    private function rpmToMph(rpm as Number) as Float {
        var circumferenceInches = Math.PI * ONEWHEEL_WHEEL_DIAMETER_INCHES;
        return (circumferenceInches * rpm * 60) / INCHES_PER_MILE;
    }

    private function celsiusToFahrenheit(celsius as Number) as Number {
        return Math.round(celsius * 9.0 / 5.0 + 32.0).toNumber();
    }

    // Warns once per ride when battery drops to half of whatever it was
    // *when this ride started* -- not a flat 50% of the full pack.
    private function checkHalfwayWarning() as Void {
        if (halfwayWarningActive || _startingBatteryLevel == null || batteryLevel == null) {
            return;
        }
        if (batteryLevel <= _startingBatteryLevel / 2) {
            halfwayWarningActive = true;
            if (Attention has :vibrate) {
                Attention.vibrate([new Attention.VibeProfile(100, 1000)]);
            }
        }
    }

    // Integrates our own RPM-derived mph over elapsed wall-clock time into
    // a running distance for this ride. Only while actually recording, so
    // "Trip" starts at zero on Start and doesn't accumulate between rides.
    private function accumulateDistance(mph as Float) as Void {
        var now = System.getTimer();
        if (isRecording() && _lastSpeedTimestampMs != null) {
            var elapsedHours = (now - (_lastSpeedTimestampMs as Number)) / 3600000.0;
            distanceMilesThisRide += mph * elapsedHours;
        }
        _lastSpeedTimestampMs = now;
    }

    // Self-calibrating range estimate: (distance covered so far) / (battery
    // %% actually consumed so far this ride), extrapolated against current
    // battery level. Deliberately not modeling pack Wh capacity or motor
    // wattage -- this adapts to current terrain/mode/rider automatically,
    // a fixed formula wouldn't. Null until enough battery has been consumed
    // to compute a meaningful rate.
    private function updateRangeEstimate() as Void {
        if (_startingBatteryLevel == null || batteryLevel == null) {
            estimatedRangeMiles = null;
            return;
        }
        var consumedPercent = (_startingBatteryLevel as Number) - (batteryLevel as Number);
        if (consumedPercent <= 0) {
            estimatedRangeMiles = null;
            return;
        }
        var milesPerPercent = distanceMilesThisRide / consumedPercent;
        estimatedRangeMiles = milesPerPercent * batteryLevel;
    }
}
