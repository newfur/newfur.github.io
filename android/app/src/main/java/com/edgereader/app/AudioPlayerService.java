package com.edgereader.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

public class AudioPlayerService extends Service {

    private static final String TAG = "AudioPlayerService";
    private static final String CHANNEL_ID = "tts_playback_channel";
    private static final int NOTIFICATION_ID = 9527;

    private MediaSession mediaSession;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    
    private boolean isPlaying = false;
    private String currentTitle = "";
    private String currentArtist = "";
    private String currentText = "";
    private Bitmap coverBitmap = null;

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "onCreate");

        // Initialize Notification Channel for Android 8.0+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "TTS Playback",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Shows media controls for text-to-speech reading");
            channel.setShowBadge(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }

        // Initialize MediaSession
        mediaSession = new MediaSession(this, "EdgeReaderTTS");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                Log.d(TAG, "MediaSession: onPlay");
                notifyJS("play");
            }

            @Override
            public void onPause() {
                Log.d(TAG, "MediaSession: onPause");
                notifyJS("pause");
            }

            @Override
            public void onSkipToNext() {
                Log.d(TAG, "MediaSession: onSkipToNext");
                notifyJS("next");
            }

            @Override
            public void onSkipToPrevious() {
                Log.d(TAG, "MediaSession: onSkipToPrevious");
                notifyJS("previous");
            }

            @Override
            public void onStop() {
                Log.d(TAG, "MediaSession: onStop");
                notifyJS("stop");
            }
        });
        
        mediaSession.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            Log.d(TAG, "onStartCommand: action = " + action);
            if (action != null) {
                switch (action) {
                    case "ACTION_PLAY_PAUSE":
                        notifyJS("toggle");
                        break;
                    case "ACTION_NEXT":
                        notifyJS("next");
                        break;
                    case "ACTION_PREVIOUS":
                        notifyJS("previous");
                        break;
                    case "ACTION_STOP":
                        notifyJS("stop");
                        break;
                    case "ACTION_START":
                        currentTitle = intent.getStringExtra("title");
                        currentArtist = intent.getStringExtra("artist");
                        currentText = intent.getStringExtra("text");
                        String coverBase64 = intent.getStringExtra("cover");
                        isPlaying = intent.getBooleanExtra("isPlaying", false);
                        
                        if (coverBase64 != null && !coverBase64.isEmpty()) {
                            coverBitmap = decodeBase64ToBitmap(coverBase64);
                        } else {
                            coverBitmap = null;
                        }
                        
                        startForegroundServiceWithNotification(currentTitle, currentArtist, currentText, isPlaying);
                        updatePlaybackState(isPlaying);
                        updateMetadata(currentTitle, currentArtist, currentText);
                        break;
                    case "ACTION_UPDATE_STATE":
                        isPlaying = intent.getBooleanExtra("isPlaying", false);
                        updatePlaybackState(isPlaying);
                        updateNotification(currentTitle, currentArtist, currentText, isPlaying);
                        break;
                    case "ACTION_UPDATE_METADATA":
                        currentTitle = intent.getStringExtra("title");
                        currentArtist = intent.getStringExtra("artist");
                        currentText = intent.getStringExtra("text");
                        updateMetadata(currentTitle, currentArtist, currentText);
                        updateNotification(currentTitle, currentArtist, currentText, isPlaying);
                        break;
                }
            }
        }
        return START_NOT_STICKY;
    }

    private void startForegroundServiceWithNotification(String title, String artist, String text, boolean isPlaying) {
        Notification notification = createNotification(title, artist, text, isPlaying);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void updateNotification(String title, String artist, String text, boolean isPlaying) {
        Notification notification = createNotification(title, artist, text, isPlaying);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, notification);
        }
    }

    private Notification createNotification(String title, String artist, String text, boolean isPlaying) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }

        builder.setContentTitle(text != null && !text.isEmpty() ? text : "Reading...")
               .setContentText(title != null && !title.isEmpty() ? title : "E-Book Reader")
               .setSubText(artist != null && !artist.isEmpty() ? artist : "TTS")
               .setSmallIcon(android.R.drawable.ic_media_play)
               .setContentIntent(pendingIntent)
               .setVisibility(Notification.VISIBILITY_PUBLIC)
               .setOngoing(isPlaying);

        if (coverBitmap != null) {
            builder.setLargeIcon(coverBitmap);
        }

        // Add Previous action
        Intent prevIntent = new Intent(this, AudioPlayerService.class).setAction("ACTION_PREVIOUS");
        PendingIntent prevPending = PendingIntent.getService(this, 2, prevIntent, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0));
        builder.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_media_previous, "Previous", prevPending).build());

        // Add Play/Pause action
        Intent playPauseIntent = new Intent(this, AudioPlayerService.class).setAction("ACTION_PLAY_PAUSE");
        PendingIntent playPausePending = PendingIntent.getService(this, 1, playPauseIntent, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0));
        builder.addAction(new Notification.Action.Builder(
                isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                isPlaying ? "Pause" : "Play",
                playPausePending).build());

        // Add Next action
        Intent nextIntent = new Intent(this, AudioPlayerService.class).setAction("ACTION_NEXT");
        PendingIntent nextPending = PendingIntent.getService(this, 3, nextIntent, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0));
        builder.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_media_next, "Next", nextPending).build());

        // Add Stop action
        Intent stopIntent = new Intent(this, AudioPlayerService.class).setAction("ACTION_STOP");
        PendingIntent stopPending = PendingIntent.getService(this, 4, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0));
        builder.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPending).build());

        // Set MediaStyle
        Notification.MediaStyle mediaStyle = new Notification.MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2);

        builder.setStyle(mediaStyle);

        return builder.build();
    }

    private void updatePlaybackState(boolean isPlaying) {
        PlaybackState.Builder stateBuilder = new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY |
                            PlaybackState.ACTION_PAUSE |
                            PlaybackState.ACTION_PLAY_PAUSE |
                            PlaybackState.ACTION_SKIP_TO_NEXT |
                            PlaybackState.ACTION_SKIP_TO_PREVIOUS |
                            PlaybackState.ACTION_STOP);

        int state = isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
        stateBuilder.setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f);
        mediaSession.setPlaybackState(stateBuilder.build());

        if (isPlaying) {
            acquireLocks();
        } else {
            releaseLocks();
        }
    }

    private void updateMetadata(String title, String artist, String text) {
        MediaMetadata.Builder metadataBuilder = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, text)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, title);
        if (coverBitmap != null) {
            metadataBuilder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, coverBitmap);
            metadataBuilder.putBitmap(MediaMetadata.METADATA_KEY_ART, coverBitmap);
        }
        mediaSession.setMetadata(metadataBuilder.build());
    }

    private Bitmap decodeBase64ToBitmap(String base64Str) {
        try {
            if (base64Str.startsWith("data:")) {
                int commaIdx = base64Str.indexOf(",");
                if (commaIdx != -1) {
                    base64Str = base64Str.substring(commaIdx + 1);
                }
            }
            byte[] decodedBytes = android.util.Base64.decode(base64Str, android.util.Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.length);
        } catch (Exception e) {
            Log.w(TAG, "Failed to decode base64 cover: " + e.getMessage());
            return null;
        }
    }

    private void acquireLocks() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "EdgeReader::TTSWakeLock");
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire();
                Log.d(TAG, "WakeLock acquired");
            }

            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "EdgeReader::TTSWifiLock");
                    } else {
                        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL, "EdgeReader::TTSWifiLock");
                    }
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) {
                wifiLock.acquire();
                Log.d(TAG, "WifiLock acquired");
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to acquire locks: " + e.getMessage());
        }
    }

    private void releaseLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                Log.d(TAG, "WakeLock released");
            }
            if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
                Log.d(TAG, "WifiLock released");
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to release locks: " + e.getMessage());
        }
    }

    private void notifyJS(String action) {
        if (NativeTTS.instance != null) {
            NativeTTS.instance.sendMediaAction(action);
        } else {
            Log.w(TAG, "Cannot notifyJS, NativeTTS.instance is null");
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        Log.d(TAG, "onDestroy");
        releaseLocks();
        if (coverBitmap != null) {
            coverBitmap.recycle();
            coverBitmap = null;
        }
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
        }
        stopForeground(true);
        super.onDestroy();
    }
}
