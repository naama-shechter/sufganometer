package com.sufganometer.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.text.NumberFormat;
import java.util.Locale;

/**
 * Foreground service that keeps the hardware step counter registered while there is a donut
 * in the queue. Android only counts steps while a listener is registered, so without this the
 * sensor stops counting when the app goes to the background.
 *
 * The app sends the current state (donut name, steps left for it, steps left in total).
 * The service counts steps from that moment and keeps the notification up to date. When all
 * donuts are burned it posts a "ready to fry" notification and stops itself.
 */
public class StepTrackingService extends Service implements SensorEventListener {

    public static final String ACTION_TRACK = "com.sufganometer.app.TRACK";

    private static final String CHANNEL_TRACKING = "step_tracking";
    private static final String CHANNEL_DONE = "fry_ready";
    private static final int NOTIF_TRACKING = 4201;
    private static final int NOTIF_DONE = 4202;
    private static final String PREFS = "sufganometer_tracking";

    private SensorManager sensorManager;
    private Sensor stepCounter;
    private boolean listening = false;

    private String name = "";
    private long remaining = 0; // steps left for the current donut, at the time of the last update
    private long total = 0;     // steps left until all donuts are burned, at the time of the last update
    private float baseRaw = -1; // raw counter value at the time of the last update
    private float lastRaw = -1;
    private long lastShownTotal = Long.MIN_VALUE;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        stepCounter = sensorManager != null ? sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) : null;
        restore();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_TRACK.equals(intent.getAction())) {
            String n = intent.getStringExtra("name");
            name = n != null ? n : "";
            remaining = intent.getLongExtra("remaining", 0);
            total = intent.getLongExtra("total", 0);
            baseRaw = -1; // count from the next sensor reading (delivered right after registering)
            persist();
        }
        // (a null intent means the system restarted us: continue from the saved state)

        ensureChannels();
        try {
            Notification n = buildTracking(remaining, total);
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_TRACKING, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH);
            } else {
                startForeground(NOTIF_TRACKING, n);
            }
        } catch (Exception e) {
            // e.g. activity-recognition permission missing: nothing we can do in the background
            stopSelf();
            return START_NOT_STICKY;
        }
        lastShownTotal = total;
        startListening();
        return START_STICKY;
    }

    private void startListening() {
        if (listening || stepCounter == null) return;
        listening = sensorManager.registerListener(this, stepCounter, SensorManager.SENSOR_DELAY_NORMAL);
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        float raw = event.values[0];
        if (baseRaw < 0 || raw < baseRaw) baseRaw = raw; // first reading, or the counter was reset
        lastRaw = raw;
        long walked = (long) (raw - baseRaw);
        long leftTotal = total - walked;
        long leftCurrent = remaining - walked;

        if (leftTotal <= 0) {
            postDone();
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }
        if (Math.abs(lastShownTotal - leftTotal) >= 10) {
            lastShownTotal = leftTotal;
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(NOTIF_TRACKING, buildTracking(leftCurrent, leftTotal));
            persist();
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    @Override
    public void onDestroy() {
        if (listening && sensorManager != null) sensorManager.unregisterListener(this);
        listening = false;
        persist();
        super.onDestroy();
    }

    // ---------- notifications ----------

    private static String fmt(long n) {
        return NumberFormat.getIntegerInstance(new Locale("he", "IL")).format(Math.max(0, n));
    }

    /** "ל" + שם. שם שכבר מיודע ("הפיסטוק מהמאפייה") → "לפיסטוק מהמאפייה" */
    private static String toName(String n) {
        return n.startsWith("ה") ? "ל" + n.substring(1) : "ל" + n;
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildTracking(long leftCurrent, long leftTotal) {
        String text = leftCurrent > 0
                ? "נשארו " + fmt(leftCurrent) + " צעדים " + toName(name)
                : name + " נשרפה! עוד " + fmt(leftTotal) + " צעדים עד שמותר סופגנייה חדשה";
        return new NotificationCompat.Builder(this, CHANNEL_TRACKING)
                .setSmallIcon(R.drawable.ic_stat_steps)
                .setContentTitle("סופגנומטר סופר צעדים")
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setContentIntent(openApp())
                .build();
    }

    private void postDone() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        Notification n = new NotificationCompat.Builder(this, CHANNEL_DONE)
                .setSmallIcon(R.drawable.ic_stat_steps)
                .setContentTitle("מותר לטגן!")
                .setContentText("חוב הסופגניות נמחק. פתחו את האפליקציה לחגוג.")
                .setAutoCancel(true)
                .setContentIntent(openApp())
                .build();
        nm.notify(NOTIF_DONE, n);
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel tracking = new NotificationChannel(CHANNEL_TRACKING, "ספירת צעדים", NotificationManager.IMPORTANCE_LOW);
        tracking.setDescription("מופיעה כל עוד יש סופגנייה בתור, כדי שהצעדים ייספרו גם ברקע");
        tracking.setShowBadge(false);
        nm.createNotificationChannel(tracking);
        NotificationChannel done = new NotificationChannel(CHANNEL_DONE, "מותר לטגן", NotificationManager.IMPORTANCE_DEFAULT);
        done.setDescription("כשכל הסופגניות בתור נשרפו");
        nm.createNotificationChannel(done);
    }

    // ---------- state (survives a restart of the service by the system) ----------

    private void persist() {
        SharedPreferences.Editor e = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        e.putString("name", name);
        e.putLong("remaining", remaining);
        e.putLong("total", total);
        e.putFloat("baseRaw", baseRaw);
        e.putFloat("lastRaw", lastRaw);
        e.apply();
    }

    private void restore() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        name = p.getString("name", "");
        remaining = p.getLong("remaining", 0);
        total = p.getLong("total", 0);
        baseRaw = p.getFloat("baseRaw", -1);
        lastRaw = p.getFloat("lastRaw", -1);
    }
}
