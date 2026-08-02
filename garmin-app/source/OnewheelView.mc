import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.System;
import Toybox.WatchUi;

class OnewheelView extends WatchUi.View {

    private var _connection as OnewheelConnection;

    public function initialize(connection as OnewheelConnection) {
        View.initialize();
        _connection = connection;
    }

    public function onUpdate(dc as Dc) as Void {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();

        if (_connection.lastError != null) {
            dc.setColor(Graphics.COLOR_RED, Graphics.COLOR_TRANSPARENT);
            dc.drawText(dc.getWidth() / 2, dc.getHeight() / 2, Graphics.FONT_XTINY, "Error: " + _connection.lastError, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
            return;
        }

        // Every element on every page is stacked using measured font heights
        // (not fixed pixel guesses) so nothing overflows the 260x260 round
        // display vertically. Horizontally, drawFittedText() below measures
        // actual text width against how much horizontal room exists at that
        // Y position on a round display (which shrinks a lot away from
        // vertical center) and wraps to a second line if needed, rather than
        // us guessing at "short enough" strings by eye.
        var width = dc.getWidth();
        var y = 2;

        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        y += drawFittedText(dc, y, Graphics.FONT_XTINY, _connection.status);

        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        y += drawFittedText(dc, y, Graphics.FONT_XTINY, currentTimeText());

        if (_connection.currentPage == 0) {
            drawRidePage(dc, width, y);
        } else if (_connection.currentPage == 1) {
            drawStatsPage(dc, width, y);
        } else {
            drawBoardPage(dc, width, y);
        }

        drawPageDots(dc, width, dc.getHeight());
    }

    // Page 0: the at-a-glance page for actually riding -- speed, battery,
    // recording state.
    private function drawRidePage(dc as Dc, width as Number, yStart as Number) as Void {
        var y = yStart;

        var speedText = _connection.speedMph == null ? "--" : _connection.speedMph.format("%.1f");
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(width / 2, y, Graphics.FONT_NUMBER_THAI_HOT, speedText, Graphics.TEXT_JUSTIFY_CENTER);
        y += dc.getFontHeight(Graphics.FONT_NUMBER_THAI_HOT);

        y += drawFittedText(dc, y, Graphics.FONT_XTINY, "mph (est.)");

        dc.setColor(batteryColor(_connection.batteryLevel), Graphics.COLOR_TRANSPARENT);
        var batteryText = _connection.batteryLevel == null ? "--" : _connection.batteryLevel.toString() + "%";
        dc.drawText(width / 2, y, Graphics.FONT_NUMBER_MEDIUM, batteryText, Graphics.TEXT_JUSTIFY_CENTER);
        y += dc.getFontHeight(Graphics.FONT_NUMBER_MEDIUM);

        if (_connection.halfwayWarningActive) {
            dc.setColor(Graphics.COLOR_ORANGE, Graphics.COLOR_TRANSPARENT);
            y += drawFittedText(dc, y, Graphics.FONT_XTINY, "Past halfway -- head back");
        }

        if (_connection.scanTimedOut) {
            // Plenty of horizontal room here (unlike the top status line),
            // so the full explanation fits instead of a cryptic short one.
            dc.setColor(Graphics.COLOR_YELLOW, Graphics.COLOR_TRANSPARENT);
            y += drawFittedText(dc, y, Graphics.FONT_XTINY, "Board not found -- check phone Bluetooth is off");
        }

        if (_connection.isRecording()) {
            dc.setColor(Graphics.COLOR_RED, Graphics.COLOR_TRANSPARENT);
            drawFittedText(dc, y, Graphics.FONT_XTINY, "● Recording");
        } else {
            dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
            drawFittedText(dc, y, Graphics.FONT_XTINY, "Start/Stop to record");
        }
    }

    // Page 1: distance/range stats. Trip/range are our own RPM-integrated
    // estimates (known unit, unverified wheel diameter); the board's own
    // raw odometers are kept as small reference numbers for when we
    // calibrate them against GPS on a future ride -- see PROTOCOL.md.
    private function drawStatsPage(dc as Dc, width as Number, yStart as Number) as Void {
        var y = yStart;

        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        y += drawFittedText(dc, y, Graphics.FONT_MEDIUM, "Trip (est.)");
        dc.drawText(width / 2, y, Graphics.FONT_NUMBER_MEDIUM, _connection.distanceMilesThisRide.format("%.2f") + " mi", Graphics.TEXT_JUSTIFY_CENTER);
        y += dc.getFontHeight(Graphics.FONT_NUMBER_MEDIUM) + 4;

        y += drawFittedText(dc, y, Graphics.FONT_MEDIUM, "Range left (est.)");
        var rangeText = _connection.estimatedRangeMiles == null ? "--" : _connection.estimatedRangeMiles.format("%.1f") + " mi";
        dc.drawText(width / 2, y, Graphics.FONT_NUMBER_MEDIUM, rangeText, Graphics.TEXT_JUSTIFY_CENTER);
        y += dc.getFontHeight(Graphics.FONT_NUMBER_MEDIUM) + 4;

        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        y += drawFittedText(dc, y, Graphics.FONT_XTINY, "raw " + valueOrDash(_connection.tripOdometer) + "/" + valueOrDash(_connection.lifeOdometer));

        if (_connection.halfwayWarningActive) {
            dc.setColor(Graphics.COLOR_ORANGE, Graphics.COLOR_TRANSPARENT);
            drawFittedText(dc, y, Graphics.FONT_XTINY, "Past halfway battery");
        }
    }

    // Page 2: board diagnostics -- mode, safety, motor temps.
    private function drawBoardPage(dc as Dc, width as Number, yStart as Number) as Void {
        var y = yStart;

        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        y += drawFittedText(dc, y, Graphics.FONT_MEDIUM, ridingModeText(_connection.ridingMode)) + 8;
        y += drawFittedText(dc, y, Graphics.FONT_MEDIUM, safetyText(_connection.safetyHeadroom)) + 8;

        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        y += drawFittedText(dc, y, Graphics.FONT_XTINY, "Motor: " + valueOrDash(_connection.motorTempAF) + "F / " + valueOrDash(_connection.motorTempBF) + "F") + 2;
        drawFittedText(dc, y, Graphics.FONT_XTINY, "Battery: " + valueOrDash(_connection.batteryTempAF) + "F / " + valueOrDash(_connection.batteryTempBF) + "F");
    }

    private function drawPageDots(dc as Dc, width as Number, height as Number) as Void {
        var dotY = height - 14;
        var spacing = 14;
        var startX = width / 2 - spacing;
        for (var i = 0; i < 3; i += 1) {
            dc.setColor(i == _connection.currentPage ? Graphics.COLOR_WHITE : Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
            dc.fillCircle(startX + (i * spacing), dotY, 3);
        }
    }

    private function batteryColor(level as Number?) as Graphics.ColorType {
        if (level == null) {
            return Graphics.COLOR_LT_GRAY;
        } else if (level >= 75) {
            return Graphics.COLOR_BLUE;
        } else if (level >= 50) {
            return Graphics.COLOR_GREEN;
        } else if (level >= 25) {
            return Graphics.COLOR_YELLOW;
        } else {
            return Graphics.COLOR_RED;
        }
    }

    private function valueOrDash(value as Number?) as String {
        return value == null ? "--" : value.toString();
    }

    // Empirically confirmed against a real GT by cycling modes in the
    // official app and watching the raw value -- see PROTOCOL.md.
    private static var RIDING_MODE_NAMES as Dictionary<Number, String> = {
        3 => "Bay",
        4 => "Roam",
        5 => "Flow",
        6 => "Highline",
        7 => "Elevated",
        8 => "Apex"
    };

    private function ridingModeText(ridingMode as Number?) as String {
        if (ridingMode == null) {
            return "Mode --";
        }
        var name = RIDING_MODE_NAMES.get(ridingMode);
        return name != null ? name : "Mode " + ridingMode;
    }

    // Showing the raw value, not a WARN/OK label -- a real ride confirmed
    // this stays "1" throughout completely normal riding, so our "boolean
    // warning flag" theory is likely wrong. See PROTOCOL.md.
    private function safetyText(safetyHeadroom as Number?) as String {
        return "Safety " + valueOrDash(safetyHeadroom);
    }

    private function currentTimeText() as String {
        var clockTime = System.getClockTime();
        var hour = clockTime.hour;
        var suffix = "";
        if (!System.getDeviceSettings().is24Hour) {
            suffix = hour >= 12 ? " PM" : " AM";
            hour = hour % 12;
            if (hour == 0) {
                hour = 12;
            }
        }
        return hour.toString() + ":" + clockTime.min.format("%02d") + suffix;
    }

    // How much horizontal room actually exists at a given Y on a round
    // display -- shrinks fast away from vertical center. 0.88 is a safety
    // margin for the bezel and devices that aren't a perfect circle.
    private function maxWidthAtY(dc as Dc, yTop as Number, textHeight as Number) as Number {
        var radius = dc.getWidth() / 2.0;
        var cy = dc.getHeight() / 2.0;
        var yMid = yTop + textHeight / 2.0;
        var dy = (yMid - cy).abs();
        if (dy >= radius) {
            return 0;
        }
        var halfWidth = Math.sqrt(radius * radius - dy * dy);
        return (halfWidth * 2 * 0.88).toNumber();
    }

    private function findSplitIndex(text as String, target as Number) as Number? {
        var best = null;
        var bestDist = 999999;
        var len = text.length();
        for (var i = 0; i < len; i += 1) {
            if (text.substring(i, i + 1).equals(" ")) {
                var dist = (i - target).abs();
                if (dist < bestDist) {
                    bestDist = dist;
                    best = i;
                }
            }
        }
        return best;
    }

    // Draws centered text, and if it wouldn't fit within the round display's
    // actual width at this Y, splits it onto a second line at the nearest
    // space to the middle instead of letting it run off the edge. Returns
    // the vertical space consumed (one or two lines) so callers can advance
    // their layout cursor correctly either way.
    private function drawFittedText(dc as Dc, y as Number, font as Graphics.FontType, text as String) as Number {
        var lineHeight = dc.getFontHeight(font);
        var textWidth = dc.getTextWidthInPixels(text, font);
        var maxWidth = maxWidthAtY(dc, y, lineHeight);

        if (textWidth <= maxWidth) {
            dc.drawText(dc.getWidth() / 2, y, font, text, Graphics.TEXT_JUSTIFY_CENTER);
            return lineHeight;
        }

        var splitAt = findSplitIndex(text, text.length() / 2);
        if (splitAt == null) {
            dc.drawText(dc.getWidth() / 2, y, font, text, Graphics.TEXT_JUSTIFY_CENTER);
            return lineHeight;
        }

        var line1 = text.substring(0, splitAt);
        var line2 = text.substring(splitAt + 1, text.length());
        dc.drawText(dc.getWidth() / 2, y, font, line1, Graphics.TEXT_JUSTIFY_CENTER);
        dc.drawText(dc.getWidth() / 2, y + lineHeight, font, line2, Graphics.TEXT_JUSTIFY_CENTER);
        return lineHeight * 2;
    }
}
