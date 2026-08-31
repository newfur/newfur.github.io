package com.edgereader.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class PlaybackSessionRegistryTest {
    @Test
    public void deliversOnlyToCurrentMatchingSession() {
        PlaybackSessionRegistry registry = new PlaybackSessionRegistry();
        List<String> oldEvents = new ArrayList<>();
        List<String> newEvents = new ArrayList<>();
        registry.register("old", oldEvents::add);
        registry.register("new", newEvents::add);

        assertFalse(registry.deliver("old", "pause"));
        assertTrue(registry.deliver("new", "play"));
        assertTrue(oldEvents.isEmpty());
        assertEquals(1, newEvents.size());
    }

    @Test
    public void unregisterIsIdempotentAndCannotRemoveNewReceiver() {
        PlaybackSessionRegistry registry = new PlaybackSessionRegistry();
        List<String> events = new ArrayList<>();
        registry.register("new", events::add);

        registry.unregister("old");
        assertTrue(registry.deliver("new", "next"));
        registry.unregister("new");
        registry.unregister("new");
        assertFalse(registry.deliver("new", "next"));
    }
}
