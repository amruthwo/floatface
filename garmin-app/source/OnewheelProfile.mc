import Toybox.BluetoothLowEnergy;

// UUIDs confirmed in PROTOCOL.md against a real Onewheel GT (firmware
// revision 0x1849). UNLOCK_RESPONSE itself is NOT defined here -- it's
// board-specific (GT's unlock is computed server-side by FutureMotion, not
// a local algorithm) and lives in LocalConfig.mc, which is gitignored.
// Copy LocalConfig.mc.example to LocalConfig.mc and fill in your own
// captured bytes -- see README.md for how to capture them.
module OnewheelProfile {

    const SERVICE_UUID = BluetoothLowEnergy.stringToUuid("e659f300-ea98-11e3-ac10-0800200c9a66");

    const FIRMWARE_REVISION_UUID   = BluetoothLowEnergy.stringToUuid("e659f311-ea98-11e3-ac10-0800200c9a66");
    const UART_SERIAL_READ_UUID    = BluetoothLowEnergy.stringToUuid("e659f3fe-ea98-11e3-ac10-0800200c9a66");
    const UART_SERIAL_WRITE_UUID   = BluetoothLowEnergy.stringToUuid("e659f3ff-ea98-11e3-ac10-0800200c9a66");
    const BATTERY_LEVEL_UUID       = BluetoothLowEnergy.stringToUuid("e659f303-ea98-11e3-ac10-0800200c9a66");
    const SPEED_RPM_UUID           = BluetoothLowEnergy.stringToUuid("e659f30b-ea98-11e3-ac10-0800200c9a66");
    const RIDING_MODE_UUID         = BluetoothLowEnergy.stringToUuid("e659f302-ea98-11e3-ac10-0800200c9a66");
    const SAFETY_HEADROOM_UUID     = BluetoothLowEnergy.stringToUuid("e659f317-ea98-11e3-ac10-0800200c9a66");
    const MOTOR_CONTROLLER_TEMP_UUID = BluetoothLowEnergy.stringToUuid("e659f310-ea98-11e3-ac10-0800200c9a66");
    const BATTERY_LOW_TEMP_UUID    = BluetoothLowEnergy.stringToUuid("e659f315-ea98-11e3-ac10-0800200c9a66");
    const STATUS_UUID              = BluetoothLowEnergy.stringToUuid("e659f30f-ea98-11e3-ac10-0800200c9a66");
    const TRIP_ODOMETER_UUID       = BluetoothLowEnergy.stringToUuid("e659f30a-ea98-11e3-ac10-0800200c9a66");
    const LIFE_ODOMETER_UUID       = BluetoothLowEnergy.stringToUuid("e659f319-ea98-11e3-ac10-0800200c9a66");

    // Re-send the unlock every 15s -- empirically the board re-locks (all
    // telemetry characteristics reporting 0) around 20s after unlocking.
    const KEEPALIVE_INTERVAL_MS = 15000;

    function registerProfile() as Void {
        BluetoothLowEnergy.registerProfile({
            :uuid => SERVICE_UUID,
            :characteristics => [
                { :uuid => FIRMWARE_REVISION_UUID },
                { :uuid => UART_SERIAL_READ_UUID, :descriptors => [BluetoothLowEnergy.cccdUuid()] },
                { :uuid => UART_SERIAL_WRITE_UUID },
                { :uuid => BATTERY_LEVEL_UUID, :descriptors => [BluetoothLowEnergy.cccdUuid()] },
                { :uuid => SPEED_RPM_UUID, :descriptors => [BluetoothLowEnergy.cccdUuid()] },
                { :uuid => RIDING_MODE_UUID, :descriptors => [BluetoothLowEnergy.cccdUuid()] },
                { :uuid => SAFETY_HEADROOM_UUID, :descriptors => [BluetoothLowEnergy.cccdUuid()] },
                { :uuid => MOTOR_CONTROLLER_TEMP_UUID, :descriptors => [BluetoothLowEnergy.cccdUuid()] },
                { :uuid => BATTERY_LOW_TEMP_UUID, :descriptors => [BluetoothLowEnergy.cccdUuid()] },
                { :uuid => STATUS_UUID, :descriptors => [BluetoothLowEnergy.cccdUuid()] },
                { :uuid => TRIP_ODOMETER_UUID, :descriptors => [BluetoothLowEnergy.cccdUuid()] },
                { :uuid => LIFE_ODOMETER_UUID, :descriptors => [BluetoothLowEnergy.cccdUuid()] }
            ]
        });
    }
}
