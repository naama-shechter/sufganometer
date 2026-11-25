package com.sufganometer.app;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Reads the raw hardware step counter (TYPE_STEP_COUNTER).
 *
 * The sensor counts steps since the last reboot, in the sensor hub, even while the app is closed.
 * The app stores the last value it saw and, when it comes back to the foreground, adds the
 * difference — so steps taken while the app was in the background are not lost.
 */
@CapacitorPlugin(name = "StepSensor")
public class StepSensorPlugin extends Plugin {

    private static final long READ_TIMEOUT_MS = 5000;

    private SensorManager sensorManager;
    private Sensor stepCounter;
    private SensorEventListener liveListener;

    @Override
    public void load() {
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        stepCounter = sensorManager != null ? sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) : null;
    }

    /** Approximate wall-clock time of the last boot, used to detect a reboot (counter resets to 0). */
    private static long bootTime() {
        return System.currentTimeMillis() - SystemClock.elapsedRealtime();
    }

    private static JSObject reading(float count) {
        JSObject r = new JSObject();
        r.put("count", (double) count);
        r.put("bootTime", bootTime());
        return r;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", stepCounter != null);
        call.resolve(r);
    }

    /** One reading of the cumulative count since boot. */
    @PluginMethod
    public void getCount(final PluginCall call) {
        if (stepCounter == null) {
            call.reject("No step counter sensor on this device");
            return;
        }
        final boolean[] done = { false };
        final SensorEventListener[] holder = new SensorEventListener[1];
        holder[0] = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                if (done[0]) return;
                done[0] = true;
                sensorManager.unregisterListener(this);
                call.resolve(reading(event.values[0]));
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        sensorManager.registerListener(holder[0], stepCounter, SensorManager.SENSOR_DELAY_FASTEST);
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (done[0]) return;
            done[0] = true;
            sensorManager.unregisterListener(holder[0]);
            call.reject("Timed out reading the step counter");
        }, READ_TIMEOUT_MS);
    }

    /** Live updates while the app is open: emits "count" events with the cumulative count. */
    @PluginMethod
    public void start(PluginCall call) {
        if (stepCounter == null) {
            call.reject("No step counter sensor on this device");
            return;
        }
        stopLive();
        liveListener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                notifyListeners("count", reading(event.values[0]));
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        sensorManager.registerListener(liveListener, stepCounter, SensorManager.SENSOR_DELAY_UI);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopLive();
        call.resolve();
    }

    private void stopLive() {
        if (liveListener != null && sensorManager != null) {
            sensorManager.unregisterListener(liveListener);
        }
        liveListener = null;
    }

    @Override
    protected void handleOnDestroy() {
        stopLive();
    }
}
