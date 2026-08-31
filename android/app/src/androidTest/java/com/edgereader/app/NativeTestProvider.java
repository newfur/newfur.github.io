package com.edgereader.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

public class NativeTestProvider extends ContentProvider {
    static int deletes;
    static int updates;
    static boolean failPublish;
    private File dataFile;

    @Override public boolean onCreate() {
        dataFile = new File(getContext().getCacheDir(), "native-provider.bin");
        try (FileOutputStream output = new FileOutputStream(dataFile)) { output.write(new byte[] { 1, 2, 3 }); }
        catch (IOException error) { return false; }
        return true;
    }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws java.io.FileNotFoundException {
        int flags = mode.contains("w")
                ? ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE | ParcelFileDescriptor.MODE_WRITE_ONLY
                : ParcelFileDescriptor.MODE_READ_ONLY;
        return ParcelFileDescriptor.open(dataFile, flags);
    }

    @Override public Uri insert(Uri uri, ContentValues values) { return uri.buildUpon().appendPath("row").build(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) {
        updates++;
        return failPublish ? 0 : 1;
    }
    @Override public int delete(Uri uri, String selection, String[] args) { deletes++; return 1; }
    @Override public String getType(Uri uri) { return "application/octet-stream"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) { return null; }
}
