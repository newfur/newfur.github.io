package com.edgereader.app;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
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
        Path root = source.getCanonicalFile().toPath();
        Path destination = output.getCanonicalFile().toPath();
        if (!Files.isDirectory(root) || Files.isSymbolicLink(source.toPath())) throw new ZipPolicyException("SOURCE_NOT_ALLOWED");
        if (Files.isSymbolicLink(output.toPath())) throw new ZipPolicyException("SYMLINK_NOT_ALLOWED");
        if (Files.exists(output.toPath())) throw new ZipPolicyException("OUTPUT_EXISTS");
        if (destination.startsWith(root)) throw new ZipPolicyException("OUTPUT_IN_SOURCE");
        File parent = output.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new ZipPolicyException("DESTINATION_UNAVAILABLE");

        boolean completed = false;
        try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(output))) {
            zip.setLevel(Deflater.NO_COMPRESSION);
            add(root, root, zip, limits, new State(), 0);
            completed = true;
        } finally {
            if (!completed) Files.deleteIfExists(output.toPath());
        }
    }

    private static void add(Path root, Path directory, ZipOutputStream zip, Limits limits, State state, int depth) throws IOException {
        if (depth > limits.maxDepth) throw new ZipPolicyException("ZIP_DEPTH_LIMIT");
        File[] children = directory.toFile().listFiles();
        if (children == null) throw new ZipPolicyException("SOURCE_NOT_ALLOWED");
        for (File child : children) {
            Path lexical = child.toPath();
            if (Files.isSymbolicLink(lexical)) throw new ZipPolicyException("SYMLINK_NOT_ALLOWED");
            Path canonical = child.getCanonicalFile().toPath();
            if (!canonical.startsWith(root)) throw new ZipPolicyException("SOURCE_NOT_ALLOWED");
            if (Files.isDirectory(canonical)) {
                add(root, canonical, zip, limits, state, depth + 1);
                continue;
            }
            if (++state.entries > limits.maxEntries) throw new ZipPolicyException("ZIP_ENTRY_LIMIT");
            String name = root.relativize(canonical).toString().replace(File.separatorChar, '/');
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
}
