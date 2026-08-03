import Toybox.Application;
import Toybox.BluetoothLowEnergy;
import Toybox.Lang;
import Toybox.Position;
import Toybox.WatchUi;

class FloatfaceApp extends Application.AppBase {

    private var _connection as OnewheelConnection?;

    function initialize() {
        AppBase.initialize();
    }

    function onStart(state as Dictionary?) as Void {
        // Without this, ActivityRecording never gets a GPS fix -- confirmed
        // by a real ride recording with zero position/speed/distance data.
        Position.enableLocationEvents(Position.LOCATION_CONTINUOUS, method(:onPosition));

        _connection = new OnewheelConnection();
        BluetoothLowEnergy.setDelegate(_connection as OnewheelConnection);
        (_connection as OnewheelConnection).startScan();
    }

    function onStop(state as Dictionary?) as Void {
        if (_connection != null) {
            (_connection as OnewheelConnection).saveIfRecording();
            (_connection as OnewheelConnection).shutdown();
        }
        _connection = null;
        Position.enableLocationEvents(Position.LOCATION_DISABLE, null);
    }

    function onPosition(info as Position.Info) as Void {
    }

    function getInitialView() as [Views] or [Views, InputDelegates] {
        return [ new OnewheelView(_connection as OnewheelConnection), new OnewheelDelegate(_connection as OnewheelConnection) ];
    }
}

function getApp() as FloatfaceApp {
    return Application.getApp() as FloatfaceApp;
}
