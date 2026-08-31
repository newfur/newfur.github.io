package com.edgereader.app;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

final class SafeZipWriter {
    static final Limits DEFAULT_LIMITS = new Limits(16, 10000, 2L * 1024 * 1024 * 1024);

    static final class Limits {
        final int maxDepth;
        final int maxEntries;
        final long maxBytes;

        Limits(int maxDepth, int maxEntries, long maxBytes) {
            this.maxDepth = maxDepth;
            this.maxEntries = maxEntries;
            this.maxBytes = maxBytes;
        }
    }

    static final class ZipPolicyException extends IOException {
        private final String code;
        ZipPolicyException(String code) { super(code); this.code = code; }
        String getCode() { return code; }
    }

    private static final class State { int entries; long bytes; }

    private SafeZipWriter() {}

    static void write(File source, File output, Limits limits) throws IOException {
        File root = source.getCanonicalFile();
        File destination = output.getCanonicalFile();
        if (!root.isDirectory() || isSymlink(source)) throw new ZipPolicyException("SOURCE_NOT_ALLOWED");
        if (isSymlink(output)) throw new ZipPolicyException("SYMLINK_NOT_ALLOWED");
        if (output.exists()) throw new ZipPolicyException("OUTPUT_EXISTS");
        if (NativeFileBoundary.isWithin(root, destination)) throw new ZipPolicyException("OUTPUT_IN_SOURCE");
        File parent = output.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new ZipPolicyException("DESTINATION_UNAVAILABLE");

        boolean outputOwned = false;
        boolean completed = false;
        try {
            if (!output.createNewFile()) throw new ZipPolicyException("OUTPUT_EXISTS");
            outputOwned = true;
            OutputStream fileOutput = new FileOutputStream(output);
            try (ZipOutputStream zip = new ZipOutputStream(fileOutput)) {
                zip.setLevel(Deflater.NO_COMPRESSION);
                add(root, root, zip, limits, new State(), 0);
                completed = true;
            }
        } finally {
            if (outputOwned && !completed && !output.delete() && output.exists()) output.deleteOnExit();
        }
    }

    private static void add(File root, File directory, ZipOutputStream zip, Limits limits, State state, int depth) throws IOException {
        if (depth > limits.maxDepth) throw new ZipPolicyException("ZIP_DEPTH_LIMIT");
        File[] children = directory.listFiles();
        if (children == null) throw new ZipPolicyException("SOURCE_NOT_ALLOWED");
        for (File child : children) {
            File canonical = child.getCanonicalFile();
            if (isSymlink(child)) throw new ZipPolicyException("SYMLINK_NOT_ALLOWED");
            if (!NativeFileBoundary.isWithin(root, canonical)) throw new ZipPolicyException("SOURCE_NOT_ALLOWED");
            if (canonical.isDirectory()) {
                add(root, canonical, zip, limits, state, depth + 1);
                continue;
            }
            if (++state.entries > limits.maxEntries) throw new ZipPolicyException("ZIP_ENTRY_LIMIT");
            String name = canonical.getPath().substring(root.getPath().length() + 1).replace(File.separatorChar, '/');
            if (name.isEmpty() || name.startsWith("/") || name.equals("..") || name.startsWith("../") || name.contains("/../")) {
                throw new ZipPolicyException("INVALID_ZIP_ENTRY");
            }
            zip.putNextEntry(new ZipEntry(name));
            try (FileInputStream input = new FileInputStream(child)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (state.bytes > limits.maxBytes - count) throw new ZipPolicyException("ZIP_BYTE_LIMIT");
                    state.bytes += count;
                    zip.write(buffer, 0, count);
                }
            } finally {
                zip.closeEntry();
            }
        }
    }

    private static boolean isSymlink(File file) throws IOException {
        File parent = file.getParentFile();
        if (parent == null) return false;
        File lexical = new File(parent.getCanonicalFile(), file.getName());
        return !lexical.getAbsolutePath().equals(lexical.getCanonicalPath());
    }
}
