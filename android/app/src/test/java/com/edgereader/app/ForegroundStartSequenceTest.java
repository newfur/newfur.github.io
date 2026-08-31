package com.edgereader.app;

import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class ForegroundStartSequenceTest {
    @Test
    public void foregroundPromotionAlwaysPrecedesCoverAndMetadataWork() {
        List<String> order = new ArrayList<>();
        ForegroundStartSequence.run(
                () -> order.add("foreground"),
                () -> order.add("cover"),
                () -> order.add("metadata"));
        assertEquals(Arrays.asList("foreground", "cover", "metadata"), order);
    }
}
