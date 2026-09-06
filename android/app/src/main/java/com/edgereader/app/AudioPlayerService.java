package com.edgereader.app;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;

/**
 * AudioPlayerService: Android Route B Native Audio Engine
 * - Twin MediaPlayer architecture (playerA / playerB) for 0ms gapless sentence playback
 * - AudioFocus management with automatic playback resumption after phone calls (AUDIOFOCUS_GAIN)
 * - MediaSession & Notification.MediaStyle lock screen / notification / Bluetooth headphone controls
 * - Foreground Service with CPU WakeLock & WifiLock to prevent Doze mode throttling
 */
public class AudioPlayerService extends Service {

    private static final String TAG = "AudioPlayerService";
    private static final String CHANNEL_ID = "tts_playback_channel_v2";
    private static final int NOTIFICATION_ID = 9527;

    public static AudioPlayerService instance;

    public static AudioPlayerService getInstance() {
        return instance;
    }

    private MediaSession mediaSession;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private AudioManager.OnAudioFocusChangeListener audioFocusChangeListener;
    private boolean wasPlayingBeforeTransientLoss = false;
    private BroadcastReceiver noisyReceiver;
    private boolean isReceiverRegistered = false;
    private String lastCoverBase64 = null;

    private boolean isPlaying = false;
    private String currentTitle = "";
    private String currentArtist = "";
    private String currentText = "";
    private Bitmap coverBitmap = null;
    private double currentChapterTotalDuration = 60.0;
    private double currentChapterProgressBase = 0.0;

    // Route B Twin-Player Engine
    private MediaPlayer playerA;
    private MediaPlayer playerB;
    private int activePlayerTag = 0;   // 0 = playerA, 1 = playerB
    private int preparedPlayerTag = 1; // 1 = playerB, 0 = playerA
    private int currentPlayingSentenceIndex = -1;
    private int preparedSentenceIndex = -1;
    private boolean isPreparedReady = false;
    private float currentPlaybackRate = 1.0f;
    private float currentPlaybackVolume = 1.0f;
    private String activePlayerFilePath = "";
    private String preparedPlayerFilePath = "";
    private volatile boolean isUserNavigatingPrevious = false;

    private boolean isAppInForeground() {
        try {
            ActivityManager.RunningAppProcessInfo appProcessInfo = new ActivityManager.RunningAppProcessInfo();
            ActivityManager.getMyMemoryState(appProcessInfo);
            return (appProcessInfo.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                    || appProcessInfo.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE);
        } catch (Exception e) {
            return false;
        }
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public interface PlayCallback {
        void onSuccess(int durationMs);
        void onError(String error);
    }

    public interface PrepareCallback {
        void onSuccess(boolean prepared);
        void onError(String error);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        Log.d(TAG, "onCreate: Initializing AudioPlayerService");

        // Initialize AudioManager and AudioFocus listener with auto-resume on AUDIOFOCUS_GAIN
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        audioFocusChangeListener = new AudioManager.OnAudioFocusChangeListener() {
            @Override
            public void onAudioFocusChange(int focusChange) {
                Log.d(TAG, "onAudioFocusChange: " + focusChange);
                switch (focusChange) {
                    case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                        // Incoming phone call or voice assistant
                        if (isPlaying) {
                            wasPlayingBeforeTransientLoss = true;
                            Log.d(TAG, "Audio focus lost transiently (e.g. phone call). Pausing playback.");
                            pauseNative();
                            notifyJS("pause");
                            evaluateJSInWebView("if (window.tts) { window.tts._pauseFromNative = true; window.tts._isInterrupted = true; window.tts.pause(); window.tts._pauseFromNative = false; }");
                        }
                        break;
                    case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                        // Transient ducking (notification ping, navigation chime)
                        Log.d(TAG, "Audio focus LOSS_TRANSIENT_CAN_DUCK received. Ducking volume.");
                        MediaPlayer active = getActivePlayer();
                        if (active != null && isPlaying) {
                            try {
                                float duckVol = 0.2f * currentPlaybackVolume;
                                active.setVolume(duckVol, duckVol);
                            } catch (Exception ignored) {}
                        }
                        break;
                    case AudioManager.AUDIOFOCUS_LOSS:
                        // Permanent loss: another audio app started
                        wasPlayingBeforeTransientLoss = false;
                        Log.d(TAG, "Audio focus lost permanently. Pausing playback.");
                        if (isPlaying) {
                            pauseNative();
                            notifyJS("pause");
                            evaluateJSInWebView("if (window.tts) { window.tts._pauseFromNative = true; window.tts.pause(); window.tts._pauseFromNative = false; }");
                        }
                        break;
                    case AudioManager.AUDIOFOCUS_GAIN:
                        Log.d(TAG, "Audio focus gained.");
                        if (wasPlayingBeforeTransientLoss) {
                            wasPlayingBeforeTransientLoss = false;
                            Log.d(TAG, "Phone call ended / transient interruption over. Automatically resuming playback!");
                            resumeNative();
                            notifyJS("play");
                            evaluateJSInWebView("if (window.tts) { window.tts._resumeFromNative = true; window.tts.resume(); window.tts._resumeFromNative = false; }");
                        } else if (isPlaying) {
                            // Restore unducked volume
                            MediaPlayer player = getActivePlayer();
                            if (player != null) {
                                try {
                                    player.setVolume(currentPlaybackVolume, currentPlaybackVolume);
                                } catch (Exception ignored) {}
                            }
                        }
                        break;
                }
            }
        };

        // Initialize Notification Channel for Android 8.0+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "TTS Playback",
                    NotificationManager.IMPORTANCE_DEFAULT
            );
            channel.setDescription("Shows media controls for text-to-speech reading");
            channel.setShowBadge(false);
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                try {
                    manager.deleteNotificationChannel("tts_playback_channel");
                } catch (Exception ignored) {}
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
                resumeNative();
                notifyJS("play");
                evaluateJSInWebView("if (window.tts) { window.tts._resumeFromNative = true; window.tts.resume(); window.tts._resumeFromNative = false; }");
            }

            @Override
            public void onPause() {
                Log.d(TAG, "MediaSession: onPause");
                pauseNative();
                notifyJS("pause");
                evaluateJSInWebView("if (window.tts) { window.tts._pauseFromNative = true; window.tts.pause(); window.tts._pauseFromNative = false; } else { document.querySelectorAll('audio').forEach(function(a) { a.pause(); }); }");
            }

            @Override
            public void onSkipToNext() {
                Log.d(TAG, "MediaSession: onSkipToNext");
                notifyJS("next");
                evaluateJSInWebView("if (window.tts) { window.tts.next(); }");
            }

            @Override
            public void onSkipToPrevious() {
                Log.d(TAG, "MediaSession: onSkipToPrevious");
                isUserNavigatingPrevious = true;
                notifyJS("previous");
                evaluateJSInWebView("if (window.tts) { window.tts.previous(); }");
            }

            @Override
            public void onStop() {
                Log.d(TAG, "MediaSession: onStop");
                stopNative();
                notifyJS("stop");
                evaluateJSInWebView("if (window.tts) { window.tts.stop(); }");
            }
        });

        mediaSession.setActive(true);
    }

    // AudioFocus Management
    private boolean requestAudioFocus() {
        if (audioManager == null) {
            audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        }
        if (audioManager == null) return false;

        int res;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                AudioAttributes playbackAttributes = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build();
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(playbackAttributes)
                        .setAcceptsDelayedFocusGain(true)
                        .setOnAudioFocusChangeListener(audioFocusChangeListener, mainHandler)
                        .build();
            }
            res = audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            res = audioManager.requestAudioFocus(audioFocusChangeListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        Log.d(TAG, "requestAudioFocus result: " + res);
        return res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
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
            Log.d(TAG, "abandonAudioFocus completed");
        } catch (Exception e) {
            Log.w(TAG, "abandonAudioFocus error: " + e.getMessage());
        }
    }

    // Route B Twin-Player Helpers
    private MediaPlayer getActivePlayer() {
        return activePlayerTag == 0 ? playerA : playerB;
    }

    private void setActivePlayer(MediaPlayer p) {
        if (activePlayerTag == 0) playerA = p;
        else playerB = p;
    }

    private MediaPlayer getPreparedPlayer() {
        return preparedPlayerTag == 0 ? playerA : playerB;
    }

    private void setPreparedPlayer(MediaPlayer p) {
        if (preparedPlayerTag == 0) playerA = p;
        else playerB = p;
    }

    private void safeReleasePlayer(MediaPlayer mp) {
        if (mp != null) {
            try {
                mp.setOnPreparedListener(null);
                mp.setOnCompletionListener(null);
                mp.setOnErrorListener(null);
            } catch (Exception ignored) {}
            try {
                if (mp.isPlaying()) {
                    mp.stop();
                }
            } catch (Exception ignored) {}
            try {
                mp.reset();
            } catch (Exception ignored) {}
            try {
                mp.release();
            } catch (Exception ignored) {}
        }
    }

    private void applyPlaybackRate(MediaPlayer player, float rate) {
        if (player == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                PlaybackParams params = player.getPlaybackParams();
                if (params == null) {
                    params = new PlaybackParams();
                }
                float speed = (rate > 0f) ? rate : 1.0f;
                params.setSpeed(speed);
                player.setPlaybackParams(params);
            } catch (Exception e) {
                Log.w(TAG, "Failed to setPlaybackParams: " + e.getMessage());
            }
        }
    }

    private boolean setupDataSource(MediaPlayer player, String filePath, String audioBase64) {
        try {
            if (filePath != null && !filePath.isEmpty()) {
                File f = new File(filePath);
                if (f.exists() && f.length() > 0) {
                    try (FileInputStream fis = new FileInputStream(f)) {
                        player.setDataSource(fis.getFD());
                    }
                    return true;
                }
            }
            if (audioBase64 != null && !audioBase64.isEmpty()) {
                String clean = audioBase64;
                if (clean.startsWith("data:")) {
                    int commaIdx = clean.indexOf(",");
                    if (commaIdx != -1) {
                        clean = clean.substring(commaIdx + 1);
                    }
                }
                byte[] bytes = Base64.decode(clean, Base64.DEFAULT);
                File fallbackFile = new File(getCacheDir(), "tts_active_fallback.mp3");
                try (FileOutputStream fos = new FileOutputStream(fallbackFile)) {
                    fos.write(bytes);
                }
                try (FileInputStream fis = new FileInputStream(fallbackFile)) {
                    player.setDataSource(fis.getFD());
                }
                return true;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error setting data source on MediaPlayer: " + e.getMessage(), e);
        }
        return false;
    }

    // Route B Native Engine Execution Methods
    public void playNativeSentence(String filePath, String audioBase64, int index, String text,
                                   String title, String artist, String coverBase64,
                                   double duration, double currentTime, float rate, float volume,
                                   PlayCallback callback) {
        mainHandler.post(() -> {
            try {
                if (title != null && !title.isEmpty()) currentTitle = title;
                if (artist != null && !artist.isEmpty()) currentArtist = artist;
                if (text != null) currentText = text;
                if (duration > 0) currentChapterTotalDuration = duration;
                if (currentTime >= 0) currentChapterProgressBase = currentTime;
                currentPlaybackRate = (rate > 0f) ? rate : 1.0f;
                currentPlaybackVolume = (volume >= 0f) ? volume : 1.0f;

                if (coverBase64 != null && !coverBase64.isEmpty()) {
                    coverBitmap = decodeBase64ToBitmap(coverBase64);
                }

                requestAudioFocus();
                isPlaying = true;
                wasPlayingBeforeTransientLoss = false;
                cancelScheduledLockRelease();
                acquireLocks();
                registerNoisyReceiver();

                // Check if this sentence is ALREADY actively playing in activePlayer
                if (currentPlayingSentenceIndex == index && getActivePlayer() != null) {
                    try {
                        if (getActivePlayer().isPlaying()) {
                            Log.d(TAG, "playNativeSentence: sentence " + index + " is already actively playing, skipping duplicate play call");
                            if (callback != null) {
                                callback.onSuccess(getActivePlayer().getDuration());
                            }
                            return;
                        }
                    } catch (Exception ignored) {}
                }

                // Guard against stale backward requests from throttled background JS while actively playing
                boolean isForeground = isAppInForeground();
                if (currentPlayingSentenceIndex > index && getActivePlayer() != null && !isUserNavigatingPrevious && !isForeground) {
                    try {
                        if (getActivePlayer().isPlaying()) {
                            Log.d(TAG, "playNativeSentence: ignoring stale backward request for sentence " + index + " while sentence " + currentPlayingSentenceIndex + " is actively playing in background");
                            if (callback != null) {
                                callback.onSuccess(getActivePlayer().getDuration());
                            }
                            return;
                        }
                    } catch (Exception ignored) {}
                }
                isUserNavigatingPrevious = false;

                // Check if preparedPlayer is already pre-warmed for this exact sentence
                if (preparedSentenceIndex == index && isPreparedReady && getPreparedPlayer() != null) {
                    Log.d(TAG, "playNativeSentence: using pre-warmed preparedPlayer for index=" + index);
                    MediaPlayer prep = getPreparedPlayer();
                    MediaPlayer oldActive = getActivePlayer();
                    setActivePlayer(null);
                    safeReleasePlayer(oldActive);

                    activePlayerTag = preparedPlayerTag;
                    preparedPlayerTag = 1 - activePlayerTag;
                    currentPlayingSentenceIndex = index;
                    preparedSentenceIndex = -1;
                    isPreparedReady = false;
                    activePlayerFilePath = preparedPlayerFilePath;
                    preparedPlayerFilePath = "";
                    setPreparedPlayer(null);

                    prep.start();
                    applyPlaybackRate(prep, currentPlaybackRate);
                    prep.setVolume(currentPlaybackVolume, currentPlaybackVolume);

                    startForegroundServiceWithNotification(currentTitle, currentArtist, currentText, true);
                    updateMetadata(currentTitle, currentArtist, currentText);
                    updatePlaybackState(true);

                    if (callback != null) {
                        callback.onSuccess(prep.getDuration());
                    }
                    return;
                }

                // Otherwise, initialize fresh active player
                MediaPlayer oldActive = getActivePlayer();
                setActivePlayer(null);
                safeReleasePlayer(oldActive);

                MediaPlayer player = new MediaPlayer();
                AudioAttributes audioAttributes = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build();
                player.setAudioAttributes(audioAttributes);
                player.setWakeMode(getApplicationContext(), PowerManager.PARTIAL_WAKE_LOCK);

                boolean srcOk = setupDataSource(player, filePath, audioBase64);
                if (!srcOk) {
                    safeReleasePlayer(player);
                    if (callback != null) callback.onError("Failed to set data source for sentence " + index);
                    return;
                }

                player.setOnCompletionListener(this::handlePlayerCompletion);
                player.setOnErrorListener((mp, what, extra) -> {
                    Log.e(TAG, "MediaPlayer error on active player: what=" + what + ", extra=" + extra);
                    safeReleasePlayer(mp);
                    setActivePlayer(null);
                    return true;
                });

                player.prepare();
                player.start();
                applyPlaybackRate(player, currentPlaybackRate);
                player.setVolume(currentPlaybackVolume, currentPlaybackVolume);

                setActivePlayer(player);
                currentPlayingSentenceIndex = index;
                activePlayerFilePath = (filePath != null) ? filePath : "";

                startForegroundServiceWithNotification(currentTitle, currentArtist, currentText, true);
                updateMetadata(currentTitle, currentArtist, currentText);
                updatePlaybackState(true);

                if (callback != null) {
                    callback.onSuccess(player.getDuration());
                }
            } catch (Exception e) {
                Log.e(TAG, "playNativeSentence ERROR: " + e.getMessage(), e);
                if (callback != null) callback.onError("Error playing sentence: " + e.getMessage());
            }
        });
    }

    public void prepareNextSentence(String filePath, String audioBase64, int index,
                                    float rate, float volume, PrepareCallback callback) {
        mainHandler.post(() -> {
            try {
                Log.d(TAG, "prepareNextSentence: index=" + index);

                // If this index is currently playing, ignore prepare request
                if (currentPlayingSentenceIndex == index && getActivePlayer() != null) {
                    try {
                        if (getActivePlayer().isPlaying()) {
                            Log.d(TAG, "prepareNextSentence: index=" + index + " is currently playing, ignoring prepare request");
                            if (callback != null) callback.onSuccess(false);
                            return;
                        }
                    } catch (Exception ignored) {}
                }

                // If this index is already prepared and ready, skip duplicate prepare
                if (preparedSentenceIndex == index && isPreparedReady && getPreparedPlayer() != null) {
                    Log.d(TAG, "prepareNextSentence: index=" + index + " is already prepared, skipping duplicate prepare");
                    if (callback != null) callback.onSuccess(true);
                    return;
                }

                // Ignore stale preparation for sentences already passed or currently playing
                if (currentPlayingSentenceIndex >= 0 && index <= currentPlayingSentenceIndex) {
                    Log.d(TAG, "prepareNextSentence: ignoring stale preparation for sentence " + index + " (currentPlayingIndex=" + currentPlayingSentenceIndex + ")");
                    if (callback != null) callback.onSuccess(false);
                    return;
                }

                MediaPlayer oldPrep = getPreparedPlayer();
                setPreparedPlayer(null);
                safeReleasePlayer(oldPrep);
                isPreparedReady = false;
                preparedSentenceIndex = -1;
                preparedPlayerFilePath = "";

                MediaPlayer prep = new MediaPlayer();
                AudioAttributes audioAttributes = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build();
                prep.setAudioAttributes(audioAttributes);
                prep.setWakeMode(getApplicationContext(), PowerManager.PARTIAL_WAKE_LOCK);

                boolean srcOk = setupDataSource(prep, filePath, audioBase64);
                if (!srcOk) {
                    safeReleasePlayer(prep);
                    if (callback != null) callback.onError("Failed to set data source for prepared sentence " + index);
                    return;
                }

                prep.setOnCompletionListener(this::handlePlayerCompletion);
                prep.setOnErrorListener((mp, what, extra) -> {
                    Log.e(TAG, "MediaPlayer error on prepared player: what=" + what + ", extra=" + extra);
                    isPreparedReady = false;
                    safeReleasePlayer(mp);
                    setPreparedPlayer(null);
                    return true;
                });

                prep.setOnPreparedListener(mp -> {
                    isPreparedReady = true;
                    preparedSentenceIndex = index;
                    preparedPlayerFilePath = (filePath != null) ? filePath : "";
                    // CRITICAL FIX: DO NOT call applyPlaybackRate here!
                    // Calling setPlaybackParams on a prepared MediaPlayer will immediately start audio playback on Android!
                    // Playback rate will be applied when player actually starts in playNativeSentence or handlePlayerCompletion.
                    try {
                        mp.setVolume((volume >= 0f) ? volume : currentPlaybackVolume,
                                     (volume >= 0f) ? volume : currentPlaybackVolume);
                    } catch (Exception ignored) {}
                    Log.d(TAG, "prepareNextSentence: pre-warmed and ready for sentence " + index + ", duration=" + mp.getDuration());
                    if (callback != null) {
                        callback.onSuccess(true);
                    }
                });

                setPreparedPlayer(prep);
                prep.prepareAsync();
            } catch (Exception e) {
                Log.e(TAG, "prepareNextSentence ERROR: " + e.getMessage(), e);
                if (callback != null) callback.onError("Failed to prepare next sentence: " + e.getMessage());
            }
        });
    }

    private void handlePlayerCompletion(MediaPlayer mp) {
        Log.d(TAG, "handlePlayerCompletion: currentPlayingIndex=" + currentPlayingSentenceIndex +
                   ", preparedIndex=" + preparedSentenceIndex + ", isPreparedReady=" + isPreparedReady);

        int finishedIndex = currentPlayingSentenceIndex;
        MediaPlayer nextPlayer = getPreparedPlayer();

        if (isPlaying && isPreparedReady && nextPlayer != null && preparedSentenceIndex == finishedIndex + 1) {
            // Gapless switch: start next pre-warmed player immediately (0ms gap!)
            nextPlayer.start();
            applyPlaybackRate(nextPlayer, currentPlaybackRate);
            nextPlayer.setVolume(currentPlaybackVolume, currentPlaybackVolume);

            int newIndex = preparedSentenceIndex;
            activePlayerTag = preparedPlayerTag;
            preparedPlayerTag = 1 - activePlayerTag;
            currentPlayingSentenceIndex = newIndex;
            preparedSentenceIndex = -1;
            isPreparedReady = false;
            activePlayerFilePath = preparedPlayerFilePath;
            preparedPlayerFilePath = "";

            // Safely reset completed player
            safeReleasePlayer(mp);
            setPreparedPlayer(null);

            // Update progress in notification safely
            double updatedCurrentTime = newIndex * 5.0;
            if (updatedCurrentTime >= currentChapterTotalDuration - 5.0) {
                currentChapterTotalDuration = updatedCurrentTime + 30.0;
            }
            currentChapterProgressBase = updatedCurrentTime;

            updateNotification(currentTitle, currentArtist, currentText, true);
            updatePlaybackState(true);

            Log.d(TAG, "Gapless switch: started pre-warmed sentence " + newIndex);
            notifySentenceStarted(newIndex, nextPlayer.getDuration());
            notifySentenceEnded(finishedIndex, true);
        } else {
            Log.d(TAG, "handlePlayerCompletion: next sentence " + (finishedIndex + 1) + " not prepared yet, notifying JS");
            safeReleasePlayer(mp);
            setActivePlayer(null);
            currentPlayingSentenceIndex = -1;
            notifySentenceEnded(finishedIndex, false);
        }
    }

    public void pauseNative() {
        isPlaying = false;
        MediaPlayer active = getActivePlayer();
        if (active != null) {
            try {
                if (active.isPlaying()) {
                    active.pause();
                }
            } catch (Exception ignored) {}
        }
        MediaPlayer prep = getPreparedPlayer();
        if (prep != null) {
            try {
                if (prep.isPlaying()) {
                    prep.pause();
                }
            } catch (Exception ignored) {}
        }
        abandonAudioFocus();
        updatePlaybackState(false);
        updateNotification(currentTitle, currentArtist, currentText, false);
    }

    public boolean resumeNative() {
        requestAudioFocus();
        isPlaying = true;
        wasPlayingBeforeTransientLoss = false;
        cancelScheduledLockRelease();
        acquireLocks();
        registerNoisyReceiver();
        MediaPlayer active = getActivePlayer();
        if (active != null) {
            try {
                active.start();
                applyPlaybackRate(active, currentPlaybackRate);
                updatePlaybackState(true);
                updateNotification(currentTitle, currentArtist, currentText, true);
                return true;
            } catch (Exception e) {
                Log.w(TAG, "Failed to start activePlayer on resume: " + e.getMessage());
            }
        }

        // Fallback: If activePlayer failed but we have activePlayerFilePath, re-create from file
        if (activePlayerFilePath != null && !activePlayerFilePath.isEmpty()) {
            File f = new File(activePlayerFilePath);
            if (f.exists() && f.length() > 0) {
                try {
                    MediaPlayer oldActive = active;
                    setActivePlayer(null);
                    safeReleasePlayer(oldActive);
                    MediaPlayer newPlayer = new MediaPlayer();
                    AudioAttributes audioAttributes = new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build();
                    newPlayer.setAudioAttributes(audioAttributes);
                    newPlayer.setWakeMode(getApplicationContext(), PowerManager.PARTIAL_WAKE_LOCK);
                    try (FileInputStream fis = new FileInputStream(f)) {
                        newPlayer.setDataSource(fis.getFD());
                    }
                    newPlayer.setOnCompletionListener(this::handlePlayerCompletion);
                    newPlayer.setOnErrorListener((mp, what, extra) -> {
                        safeReleasePlayer(mp);
                        setActivePlayer(null);
                        return true;
                    });
                    newPlayer.prepare();
                    newPlayer.start();
                    applyPlaybackRate(newPlayer, currentPlaybackRate);
                    newPlayer.setVolume(currentPlaybackVolume, currentPlaybackVolume);
                    setActivePlayer(newPlayer);
                    updatePlaybackState(true);
                    updateNotification(currentTitle, currentArtist, currentText, true);
                    return true;
                } catch (Exception e) {
                    Log.w(TAG, "Failed to re-create activePlayer from file: " + e.getMessage());
                }
            }
        }
        updatePlaybackState(true);
        updateNotification(currentTitle, currentArtist, currentText, true);
        return false;
    }

    public void stopNative() {
        isPlaying = false;
        wasPlayingBeforeTransientLoss = false;
        currentPlayingSentenceIndex = -1;
        preparedSentenceIndex = -1;
        isPreparedReady = false;
        activePlayerFilePath = "";
        preparedPlayerFilePath = "";

        safeReleasePlayer(playerA);
        playerA = null;
        safeReleasePlayer(playerB);
        playerB = null;

        abandonAudioFocus();
        cancelScheduledLockRelease();
        releaseLocks();
        unregisterNoisyReceiver();
        updatePlaybackState(false);
        stopForeground(true);
        stopSelf();
    }

    public void setRateNative(float rate) {
        this.currentPlaybackRate = (rate > 0f) ? rate : 1.0f;
        applyPlaybackRate(getActivePlayer(), currentPlaybackRate);
        applyPlaybackRate(getPreparedPlayer(), currentPlaybackRate);
    }

    public void setVolumeNative(float volume) {
        this.currentPlaybackVolume = (volume >= 0f) ? volume : 1.0f;
        MediaPlayer active = getActivePlayer();
        if (active != null) {
            try { active.setVolume(currentPlaybackVolume, currentPlaybackVolume); } catch (Exception ignored) {}
        }
        MediaPlayer prep = getPreparedPlayer();
        if (prep != null) {
            try { prep.setVolume(currentPlaybackVolume, currentPlaybackVolume); } catch (Exception ignored) {}
        }
    }

    public void simulateAudioFocusChange(int focusChange) {
        if (audioFocusChangeListener != null) {
            audioFocusChangeListener.onAudioFocusChange(focusChange);
        }
    }

    public boolean isPlaying() {
        return isPlaying;
    }

    public int getCurrentPlayingSentenceIndex() {
        return currentPlayingSentenceIndex;
    }

    public int getPreparedSentenceIndex() {
        return preparedSentenceIndex;
    }

    public boolean isPreparedReady() {
        return isPreparedReady;
    }

    public String getActivePlayerFilePath() {
        return activePlayerFilePath;
    }

    public String getPreparedPlayerFilePath() {
        return preparedPlayerFilePath;
    }

    public float getCurrentPlaybackRate() {
        return currentPlaybackRate;
    }

    private void notifySentenceStarted(int index, int durationMs) {
        if (NativeTTS.instance != null) {
            NativeTTS.instance.sendSentenceStarted(index, durationMs / 1000.0);
        }
    }

    private void notifySentenceEnded(int index, boolean gaplessHandled) {
        if (NativeTTS.instance != null) {
            NativeTTS.instance.sendSentenceEnded(index, gaplessHandled);
        }
    }

    private void notifySentenceEnded(int index) {
        notifySentenceEnded(index, false);
    }

    private void notifyJS(String action) {
        if (NativeTTS.instance != null) {
            NativeTTS.instance.sendMediaAction(action);
        } else {
            Log.w(TAG, "Cannot notifyJS, NativeTTS.instance is null");
        }
    }

    private void evaluateJSInWebView(String jsCode) {
        try {
            if (NativeTTS.instance != null && NativeTTS.instance.getBridge() != null && NativeTTS.instance.getBridge().getWebView() != null) {
                NativeTTS.instance.getBridge().getWebView().post(() -> {
                    try {
                        NativeTTS.instance.getBridge().getWebView().evaluateJavascript(jsCode, null);
                    } catch (Exception e) {
                        Log.w(TAG, "Failed to evaluateJavascript: " + e.getMessage());
                    }
                });
            }
        } catch (Exception e) {
            Log.w(TAG, "Error evaluating JS in webview: " + e.getMessage());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            Log.d(TAG, "onStartCommand: action = " + action);
            if (action != null) {
                switch (action) {
                    case "ACTION_INIT":
                        startForegroundServiceWithNotification(currentTitle, currentArtist, currentText, isPlaying);
                        break;
                    case "ACTION_PLAY_PAUSE":
                        if (isPlaying) {
                            pauseNative();
                            notifyJS("pause");
                            evaluateJSInWebView("if (window.tts) { window.tts._pauseFromNative = true; window.tts.pause(); window.tts._pauseFromNative = false; } else { document.querySelectorAll('audio').forEach(function(a) { a.pause(); }); }");
                        } else {
                            resumeNative();
                            notifyJS("play");
                            evaluateJSInWebView("if (window.tts) { window.tts._resumeFromNative = true; window.tts.resume(); window.tts._resumeFromNative = false; }");
                        }
                        break;
                    case "ACTION_NEXT":
                        notifyJS("next");
                        evaluateJSInWebView("if (window.tts) { window.tts.next(); }");
                        break;
                    case "ACTION_PREVIOUS":
                        isUserNavigatingPrevious = true;
                        notifyJS("previous");
                        evaluateJSInWebView("if (window.tts) { window.tts.previous(); }");
                        break;
                    case "ACTION_STOP":
                        stopNative();
                        notifyJS("stop");
                        evaluateJSInWebView("if (window.tts) { window.tts.stop(); }");
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

                        if (isPlaying) {
                            requestAudioFocus();
                            cancelScheduledLockRelease();
                            acquireLocks();
                            registerNoisyReceiver();
                        } else {
                            abandonAudioFocus();
                            unregisterNoisyReceiver();
                            scheduleLockRelease();
                        }

                        updateMetadata(currentTitle, currentArtist, currentText);
                        updatePlaybackState(isPlaying);
                        startForegroundServiceWithNotification(currentTitle, currentArtist, currentText, isPlaying);
                        break;
                    case "ACTION_UPDATE_STATE":
                        boolean newPlaying = intent.getBooleanExtra("isPlaying", false);
                        isPlaying = newPlaying;
                        if (!isPlaying) {
                            MediaPlayer active = getActivePlayer();
                            if (active != null) {
                                try {
                                    if (active.isPlaying()) active.pause();
                                } catch (Exception ignored) {}
                            }
                            MediaPlayer prep = getPreparedPlayer();
                            if (prep != null) {
                                try {
                                    if (prep.isPlaying()) prep.pause();
                                } catch (Exception ignored) {}
                            }
                            abandonAudioFocus();
                            unregisterNoisyReceiver();
                            scheduleLockRelease();
                        } else {
                            requestAudioFocus();
                            cancelScheduledLockRelease();
                            acquireLocks();
                            registerNoisyReceiver();
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

        String displayTitle = (text != null && !text.isEmpty()) ? text : (title != null && !title.isEmpty() ? title : "Reading...");
        String displaySubtitle = (title != null && !title.isEmpty()) ? title : "E-Book Reader";
        String displayArtist = (artist != null && !artist.isEmpty()) ? artist : "TTS";

        builder.setContentTitle(displayTitle)
               .setContentText(displaySubtitle)
               .setSubText(displayArtist)
               .setSmallIcon(isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play)
               .setContentIntent(pendingIntent)
               .setVisibility(Notification.VISIBILITY_PUBLIC)
               .setCategory(Notification.CATEGORY_TRANSPORT)
               .setOnlyAlertOnce(true)
               .setOngoing(isPlaying);

        if (coverBitmap != null && !coverBitmap.isRecycled()) {
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

        // Dismiss action
        Intent deleteIntent = new Intent(this, AudioPlayerService.class).setAction("ACTION_STOP");
        PendingIntent deletePending = PendingIntent.getService(this, 5, deleteIntent, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0));
        builder.setDeleteIntent(deletePending);

        return builder.build();
    }

    private void updatePlaybackState(boolean isPlaying) {
        this.isPlaying = isPlaying;
        if (mediaSession == null) return;

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
        long positionMs = (long)(currentChapterProgressBase * 1000);
        if (positionMs < 0) positionMs = 0;
        stateBuilder.setState(state, positionMs, isPlaying ? currentPlaybackRate : 0.0f, android.os.SystemClock.elapsedRealtime());
        mediaSession.setPlaybackState(stateBuilder.build());

        if (isPlaying) {
            cancelScheduledLockRelease();
            acquireLocks();
            registerNoisyReceiver();
        } else {
            unregisterNoisyReceiver();
            scheduleLockRelease();
        }
    }

    private void registerNoisyReceiver() {
        if (!isReceiverRegistered) {
            if (noisyReceiver == null) {
                noisyReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                            Log.d(TAG, "Audio becoming noisy (headphones unplugged), pausing...");
                            if (isPlaying) {
                                pauseNative();
                                notifyJS("pause");
                                evaluateJSInWebView("if (window.tts) { window.tts._pauseFromNative = true; window.tts.pause(); window.tts._pauseFromNative = false; } else { document.querySelectorAll('audio').forEach(function(a) { a.pause(); }); }");
                            }
                        }
                    }
                };
            }
            try {
                registerReceiver(noisyReceiver, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
                isReceiverRegistered = true;
            } catch (Exception e) {
                Log.w(TAG, "Failed to register noisy receiver: " + e.getMessage());
            }
        }
    }

    private void unregisterNoisyReceiver() {
        if (isReceiverRegistered && noisyReceiver != null) {
            try {
                unregisterReceiver(noisyReceiver);
            } catch (Exception ignored) {}
            isReceiverRegistered = false;
        }
    }

    private Runnable lockReleaseRunnable = null;
    private final Handler lockHandler = new Handler(Looper.getMainLooper());

    private void scheduleLockRelease() {
        cancelScheduledLockRelease();
        lockReleaseRunnable = () -> {
            releaseLocks();
            Log.d(TAG, "WakeLock released after 30min pause grace period");
        };
        lockHandler.postDelayed(lockReleaseRunnable, 30 * 60 * 1000);
    }

    private void cancelScheduledLockRelease() {
        if (lockReleaseRunnable != null) {
            lockHandler.removeCallbacks(lockReleaseRunnable);
            lockReleaseRunnable = null;
        }
    }

    private void updateMetadata(String title, String artist, String text) {
        if (mediaSession == null) return;
        try {
            long durationMs = (long)(currentChapterTotalDuration * 1000);
            if (durationMs <= 0) durationMs = 60000;
            MediaMetadata.Builder metadataBuilder = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, (text != null && !text.isEmpty()) ? text : title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, (artist != null && !artist.isEmpty()) ? artist : "E-Book Reader")
                    .putString(MediaMetadata.METADATA_KEY_ALBUM, (title != null && !title.isEmpty()) ? title : "TTS Reading")
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
            if (coverBitmap != null && !coverBitmap.isRecycled()) {
                metadataBuilder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, coverBitmap);
            }
            mediaSession.setMetadata(metadataBuilder.build());
        } catch (Exception e) {
            Log.w(TAG, "Failed to update MediaMetadata: " + e.getMessage());
        }
    }

    private Bitmap decodeBase64ToBitmap(String base64Str) {
        if (base64Str == null || base64Str.isEmpty()) return null;
        if (base64Str.equals(lastCoverBase64) && coverBitmap != null && !coverBitmap.isRecycled()) {
            return coverBitmap;
        }
        try {
            String clean = base64Str;
            if (clean.startsWith("data:")) {
                int commaIdx = clean.indexOf(",");
                if (commaIdx != -1) {
                    clean = clean.substring(commaIdx + 1);
                }
            }
            byte[] decodedBytes = Base64.decode(clean, Base64.DEFAULT);
            Bitmap newBmp = BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.length);
            if (newBmp != null) {
                if (coverBitmap != null && coverBitmap != newBmp && !coverBitmap.isRecycled()) {
                    coverBitmap.recycle();
                }
                lastCoverBase64 = base64Str;
                return newBmp;
            }
        } catch (Throwable t) {
            Log.w(TAG, "Failed to decode base64 cover: " + t.getMessage());
        }
        return coverBitmap;
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

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        Log.d(TAG, "onTaskRemoved: app removed from recents");
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        Log.d(TAG, "onDestroy");
        abandonAudioFocus();
        cancelScheduledLockRelease();
        unregisterNoisyReceiver();
        releaseLocks();
        safeReleasePlayer(playerA);
        playerA = null;
        safeReleasePlayer(playerB);
        playerB = null;
        if (coverBitmap != null) {
            coverBitmap.recycle();
            coverBitmap = null;
        }
        lastCoverBase64 = null;
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
        }
        stopForeground(true);
        if (instance == this) {
            instance = null;
        }
        super.onDestroy();
    }
}
