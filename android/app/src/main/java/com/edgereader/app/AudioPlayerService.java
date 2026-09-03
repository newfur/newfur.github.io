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
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
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
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private boolean wasPlayingBeforeFocusLoss = false;
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
        mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public boolean onMediaButtonEvent(Intent mediaButtonIntent) {
                if (mediaButtonIntent != null && Intent.ACTION_MEDIA_BUTTON.equals(mediaButtonIntent.getAction())) {
                    android.view.KeyEvent event = mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                    if (event != null && event.getAction() == android.view.KeyEvent.ACTION_DOWN) {
                        int keyCode = event.getKeyCode();
                        Log.d(TAG, "MediaSession onMediaButtonEvent keyCode: " + keyCode);
                        switch (keyCode) {
                            case android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                            case android.view.KeyEvent.KEYCODE_HEADSETHOOK:
                                if (isPlaying) {
                                    onPause();
                                } else {
                                    onPlay();
                                }
                                return true;
                            case android.view.KeyEvent.KEYCODE_MEDIA_PLAY:
                                onPlay();
                                return true;
                            case android.view.KeyEvent.KEYCODE_MEDIA_PAUSE:
                                onPause();
                                return true;
                            case android.view.KeyEvent.KEYCODE_MEDIA_STOP:
                                onStop();
                                return true;
                            case android.view.KeyEvent.KEYCODE_MEDIA_NEXT:
                                onSkipToNext();
                                return true;
                            case android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                                onSkipToPrevious();
                                return true;
                        }
                    }
                }
                return super.onMediaButtonEvent(mediaButtonIntent);
            }

            @Override
            public void onPlay() {
                Log.d(TAG, "MediaSession: onPlay");
                isPlaying = true;
                updatePlaybackState(true);
                updateNotification(currentTitle, currentArtist, currentText, true);
                notifyJS("play");
            }

            @Override
            public void onPause() {
                Log.d(TAG, "MediaSession: onPause");
                isPlaying = false;
                updatePlaybackState(false);
                updateNotification(currentTitle, currentArtist, currentText, false);
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
                isPlaying = false;
                updatePlaybackState(false);
                abandonAudioFocus();
                wasPlayingBeforeFocusLoss = false;
                notifyJS("stop");
                stopForeground(true);
                stopSelf();
            }
        });
        
        mediaSession.setActive(true);

        // Initialize AudioManager for Audio Focus handling
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
    }

    private final AudioManager.OnAudioFocusChangeListener audioFocusChangeListener = new AudioManager.OnAudioFocusChangeListener() {
        @Override
        public void onAudioFocusChange(int focusChange) {
            Log.d(TAG, "onAudioFocusChange: " + focusChange);
            switch (focusChange) {
                case AudioManager.AUDIOFOCUS_LOSS:
                    // 永久失去音频焦点（其他应用开始持续播放音乐/视频）
                    Log.d(TAG, "AUDIOFOCUS_LOSS");
                    wasPlayingBeforeFocusLoss = false;
                    isPlaying = false;
                    updatePlaybackState(false);
                    updateNotification(currentTitle, currentArtist, currentText, false);
                    notifyJS("pause");
                    break;
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                    // 短暂失去音频焦点（来电、语音消息、导航播报等）
                    Log.d(TAG, "AUDIOFOCUS_LOSS_TRANSIENT (wasPlaying=" + isPlaying + ")");
                    if (isPlaying) {
                        wasPlayingBeforeFocusLoss = true;
                        isPlaying = false;
                        updatePlaybackState(false);
                        updateNotification(currentTitle, currentArtist, currentText, false);
                        notifyJS("pause");
                    }
                    break;
                case AudioManager.AUDIOFOCUS_GAIN:
                    // 重新获取音频焦点（电话挂断、语音播完、导航播报结束）
                    Log.d(TAG, "AUDIOFOCUS_GAIN (wasPlayingBefore=" + wasPlayingBeforeFocusLoss + ")");
                    if (wasPlayingBeforeFocusLoss) {
                        wasPlayingBeforeFocusLoss = false;
                        isPlaying = true;
                        updatePlaybackState(true);
                        updateNotification(currentTitle, currentArtist, currentText, true);
                        // 延迟 120ms 确保底层音频输出通道已完全交还
                        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                            notifyJS("play");
                        }, 120);
                    }
                    break;
            }
        }
    };

    private boolean requestAudioFocus() {
        if (audioManager == null) {
            audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        }
        if (audioManager == null) return false;

        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                AudioAttributes playbackAttributes = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build();
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(playbackAttributes)
                        .setAcceptsDelayedFocusGain(true)
                        .setOnAudioFocusChangeListener(audioFocusChangeListener)
                        .build();
            }
            result = audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            result = audioManager.requestAudioFocus(
                    audioFocusChangeListener,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN
            );
        }
        Log.d(TAG, "requestAudioFocus result: " + result);
        return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonAudioFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (audioFocusRequest != null) {
                    audioManager.abandonAudioFocusRequest(audioFocusRequest);
                }
            } else {
                audioManager.abandonAudioFocus(audioFocusChangeListener);
            }
            Log.d(TAG, "abandonAudioFocus called");
        } catch (Exception e) {
            Log.w(TAG, "Error abandoning audio focus: " + e.getMessage());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            Log.d(TAG, "onStartCommand: action = " + action);
            if (action != null) {
                switch (action) {
                    case "ACTION_PLAY_PAUSE":
                        if (isPlaying) {
                            isPlaying = false;
                            updatePlaybackState(false);
                            updateNotification(currentTitle, currentArtist, currentText, false);
                            notifyJS("pause");
                        } else {
                            isPlaying = true;
                            updatePlaybackState(true);
                            updateNotification(currentTitle, currentArtist, currentText, true);
                            notifyJS("play");
                        }
                        break;
                    case "ACTION_NEXT":
                        notifyJS("next");
                        break;
                    case "ACTION_PREVIOUS":
                        notifyJS("previous");
                        break;
                    case "ACTION_STOP":
                        cancelScheduledLockRelease();
                        abandonAudioFocus();
                        wasPlayingBeforeFocusLoss = false;
                        isPlaying = false;
                        updatePlaybackState(false);
                        notifyJS("stop");
                        stopForeground(true);
                        stopSelf();
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
                        
                        updatePlaybackState(isPlaying);
                        startForegroundServiceWithNotification(currentTitle, currentArtist, currentText, isPlaying);
                        updateMetadata(currentTitle, currentArtist, currentText);
                        break;
                    case "ACTION_UPDATE_STATE":
                        isPlaying = intent.getBooleanExtra("isPlaying", false);
                        if (!isPlaying) {
                            wasPlayingBeforeFocusLoss = false;
                        }
                        updatePlaybackState(isPlaying);
                        updateNotification(currentTitle, currentArtist, currentText, isPlaying);
                        break;
                    case "ACTION_UPDATE_METADATA":
                        currentTitle = intent.getStringExtra("title");
                        currentArtist = intent.getStringExtra("artist");
                        currentText = intent.getStringExtra("text");
                        if (intent.hasExtra("isPlaying")) {
                            isPlaying = intent.getBooleanExtra("isPlaying", isPlaying);
                        }
                        if (intent.hasExtra("cover")) {
                            String updateCoverBase64 = intent.getStringExtra("cover");
                            if (updateCoverBase64 != null && !updateCoverBase64.isEmpty()) {
                                coverBitmap = decodeBase64ToBitmap(updateCoverBase64);
                            }
                        }
                        updateMetadata(currentTitle, currentArtist, currentText);
                        updatePlaybackState(isPlaying);
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
               .setSmallIcon(isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play)
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

        // Add Delete (dismiss) action when paused
        Intent deleteIntent = new Intent(this, AudioPlayerService.class).setAction("ACTION_STOP");
        PendingIntent deletePending = PendingIntent.getService(this, 5, deleteIntent, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0));
        builder.setDeleteIntent(deletePending);

        return builder.build();
    }

    private void updatePlaybackState(boolean isPlaying) {
        this.isPlaying = isPlaying;
        long actions = PlaybackState.ACTION_PLAY_PAUSE |
                       PlaybackState.ACTION_SKIP_TO_NEXT |
                       PlaybackState.ACTION_SKIP_TO_PREVIOUS |
                       PlaybackState.ACTION_STOP;

        if (isPlaying) {
            actions |= PlaybackState.ACTION_PAUSE;
        } else {
            actions |= PlaybackState.ACTION_PLAY;
        }

        PlaybackState.Builder stateBuilder = new PlaybackState.Builder()
                .setActions(actions);

        int state = isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
        stateBuilder.setState(state, 0, isPlaying ? 1.0f : 0.0f, android.os.SystemClock.elapsedRealtime());
        mediaSession.setPlaybackState(stateBuilder.build());

        if (isPlaying) {
            cancelScheduledLockRelease();
            requestAudioFocus();
            acquireLocks();
        } else {
            scheduleLockRelease();
        }
    }

    private Runnable lockReleaseRunnable = null;
    private final android.os.Handler lockHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    private void scheduleLockRelease() {
        cancelScheduledLockRelease();
        lockReleaseRunnable = () -> {
            releaseLocks();
            Log.d(TAG, "WakeLock released after 5min pause grace period");
        };
        lockHandler.postDelayed(lockReleaseRunnable, 5 * 60 * 1000);
    }

    private void cancelScheduledLockRelease() {
        if (lockReleaseRunnable != null) {
            lockHandler.removeCallbacks(lockReleaseRunnable);
            lockReleaseRunnable = null;
        }
    }

    private void updateMetadata(String title, String artist, String text) {
        MediaMetadata.Builder metadataBuilder = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, text)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, title);
        if (coverBitmap != null) {
            metadataBuilder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, coverBitmap);
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
        cancelScheduledLockRelease();
        abandonAudioFocus();
        wasPlayingBeforeFocusLoss = false;
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
