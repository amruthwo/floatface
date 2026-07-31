import Toybox.Lang;
import Toybox.WatchUi;

class OnewheelDelegate extends WatchUi.BehaviorDelegate {

    private var _connection as OnewheelConnection;

    public function initialize(connection as OnewheelConnection) {
        BehaviorDelegate.initialize();
        _connection = connection;
    }

    // The physical Start/Stop button -- toggles activity recording.
    public function onSelect() as Boolean {
        _connection.toggleRecording();
        return true;
    }

    // Physical Up/Down buttons -- page through the display.
    public function onNextPage() as Boolean {
        _connection.nextPage();
        return true;
    }

    public function onPreviousPage() as Boolean {
        _connection.previousPage();
        return true;
    }
}
