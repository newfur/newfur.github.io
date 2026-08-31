package com.edgereader.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class SafeZipWriterTest {
    @Rule public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void writesNestedFilesWithPortableSafeEntryNames() throws Exception {
        File source = temporaryFolder.newFolder("staging");
        File nested = new File(source, "books");
        assertFalse(nested.exists());
        Files.createDirectories(nested.toPath());
        Files.write(new File(source, "metadata.json").toPath(), "meta".getBytes(StandardCharsets.UTF_8));
        Files.write(new File(nested, "one.bin").toPath(), new byte[] { 1, 2, 3 });
        File output = new File(temporaryFolder.newFolder("output"), "backup.zip");

        SafeZipWriter.write(source, output, new SafeZipWriter.Limits(8, 10, 1024));

        Map<String, byte[]> entries = readEntries(output);
        assertArrayEquals("meta".getBytes(StandardCharsets.UTF_8), entries.get("metadata.json"));
        assertArrayEquals(new byte[] { 1, 2, 3 }, entries.get("books/one.bin"));
    }

    @Test
    public void rejectsOutputInsideSourceAndCleansOnlyItsOutput() throws Exception {
        File source = temporaryFolder.newFolder("staging");
        File retained = new File(source, "retained.txt");
        Files.write(retained.toPath(), new byte[] { 1 });
        File output = new File(source, "backup.zip");

        assertCode("OUTPUT_IN_SOURCE", () -> SafeZipWriter.write(source, output, SafeZipWriter.DEFAULT_LIMITS));
        assertFalse(output.exists());
        assertEquals(1, Files.readAllBytes(retained.toPath()).length);
    }

    @Test
    public void rejectsSymlinkFilesAndDirectories() throws Exception {
        File source = temporaryFolder.newFolder("staging");
        File external = temporaryFolder.newFile("secret.bin");
        Files.createSymbolicLink(new File(source, "linked.bin").toPath(), external.toPath());
        File output = new File(temporaryFolder.newFolder("output"), "backup.zip");

        assertCode("SYMLINK_NOT_ALLOWED", () -> SafeZipWriter.write(source, output, SafeZipWriter.DEFAULT_LIMITS));
        assertFalse(output.exists());
    }

    @Test
    public void rejectsExistingOrSymlinkOutputWithoutDeletingItsTarget() throws Exception {
        File source = temporaryFolder.newFolder("staging");
        Files.write(new File(source, "entry.bin").toPath(), new byte[] { 1 });
        File outputDir = temporaryFolder.newFolder("output");
        File existing = new File(outputDir, "existing.zip");
        Files.write(existing.toPath(), new byte[] { 7 });
        assertCode("OUTPUT_EXISTS", () -> SafeZipWriter.write(source, existing, SafeZipWriter.DEFAULT_LIMITS));
        assertEquals(7, Files.readAllBytes(existing.toPath())[0]);

        File target = new File(outputDir, "target.zip");
        Files.write(target.toPath(), new byte[] { 9 });
        File link = new File(outputDir, "linked.zip");
        Files.createSymbolicLink(link.toPath(), target.toPath());
        assertCode("SYMLINK_NOT_ALLOWED", () -> SafeZipWriter.write(source, link, SafeZipWriter.DEFAULT_LIMITS));
        assertEquals(9, Files.readAllBytes(target.toPath())[0]);
    }

    @Test
    public void enforcesDepthEntryAndByteLimits() throws Exception {
        File source = temporaryFolder.newFolder("staging");
        File deep = new File(source, "a/b/c");
        Files.createDirectories(deep.toPath());
        Files.write(new File(deep, "deep.bin").toPath(), new byte[] { 1 });
        File output = new File(temporaryFolder.newFolder("output"), "backup.zip");
        assertCode("ZIP_DEPTH_LIMIT", () -> SafeZipWriter.write(source, output, new SafeZipWriter.Limits(2, 10, 100)));

        Files.write(new File(source, "second.bin").toPath(), new byte[] { 1 });
        assertCode("ZIP_ENTRY_LIMIT", () -> SafeZipWriter.write(source, output, new SafeZipWriter.Limits(8, 1, 100)));

        assertCode("ZIP_BYTE_LIMIT", () -> SafeZipWriter.write(source, output, new SafeZipWriter.Limits(8, 10, 1)));
    }

    private static Map<String, byte[]> readEntries(File zip) throws Exception {
        Map<String, byte[]> entries = new HashMap<>();
        try (ZipInputStream input = new ZipInputStream(Files.newInputStream(zip.toPath()))) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[64];
                int count;
                while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
                entries.put(entry.getName(), bytes.toByteArray());
            }
        }
        return entries;
    }

    private static void assertCode(String code, ThrowingRunnable action) throws Exception {
        try {
            action.run();
            fail("Expected " + code);
        } catch (SafeZipWriter.ZipPolicyException error) {
            assertEquals(code, error.getCode());
        }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
}
