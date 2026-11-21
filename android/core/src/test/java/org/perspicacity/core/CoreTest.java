package org.perspicacity.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.junit.Test;

public class CoreTest {
    @Test public void registrableDomain() {
        assertEquals("example.com", Site.registrableDomain("www.example.com"));
        assertEquals("example.co.uk", Site.registrableDomain("a.b.example.co.uk"));
        assertEquals("user.github.io", Site.registrableDomain("user.github.io"));
        assertEquals("127.0.0.1", Site.registrableDomain("127.0.0.1"));
    }

    @Test public void httpsUpgrade() {
        assertEquals("https://example.com/a?b=1", Site.httpsUpgrade("http://example.com/a?b=1"));
        assertEquals("https://example.com/", Site.httpsUpgrade("http://example.com:80/"));
        assertEquals("https://example.com/", Site.httpsUpgrade("http://example.com"));
        assertNull(Site.httpsUpgrade("https://example.com/"));
        assertNull(Site.httpsUpgrade("http://abcdef.onion/"));
        assertNull(Site.httpsUpgrade("http://127.0.0.1:8080/"));
    }

    @Test public void omnibox() {
        String t = "https://search.test/?q=%s";
        assertEquals("https://example.com/", Site.omniboxToUrl("example.com", t));
        assertEquals("https://example.com/path?x=1", Site.omniboxToUrl("example.com/path?x=1", t));
        assertEquals("http://abcdef.onion/", Site.omniboxToUrl("abcdef.onion", t));
        assertEquals("http://localhost:8080/", Site.omniboxToUrl("localhost:8080", t));
        assertEquals("https://search.test/?q=what%20is%20tor", Site.omniboxToUrl("what is tor", t));
        assertNull(Site.omniboxToUrl("javascript:alert(1)", t));
        assertNull(Site.omniboxToUrl("intent://scan#Intent;end", t));
        assertNull(Site.omniboxToUrl("file:///sdcard/x", t));
        assertEquals("https://example.com", Site.omniboxToUrl("https://example.com", t));
    }

    @Test public void filter() {
        FilterEngine f = new FilterEngine();
        f.addList("||tracker.com^\n||widgets.com^$third-party\n@@||good.tracker.com^\n||facebook.com/tr^\nexample.com##.ad");
        assertEquals(4, f.ruleCount());
        assertNotNull(f.match("https://cdn.tracker.com/x.js", "https://site.com/"));
        assertNull(f.match("https://good.tracker.com/x.js", "https://site.com/"));
        assertNull(f.match("https://nottracker.com/x.js", "https://site.com/"));
        assertNotNull(f.match("https://widgets.com/w.js", "https://news.com/"));
        assertNull(f.match("https://static.widgets.com/w.js", "https://www.widgets.com/"));
        assertNotNull(f.match("https://www.facebook.com/tr?id=1", "https://x.com/"));
        assertNull(f.match("https://www.facebook.com/profile", "https://x.com/"));
    }

    @Test public void bundledListMatchesDesktopBehaviour() throws Exception {
        String dir = System.getProperty("perspicacity.shared", "../../shared");
        String text = new String(Files.readAllBytes(Paths.get(dir, "filters", "trackers.txt")), StandardCharsets.UTF_8);
        FilterEngine f = new FilterEngine();
        assertTrue(f.addList(text) > 100);
        assertNotNull(f.match("https://www.google-analytics.com/analytics.js", "https://news.com/"));
        assertNull(f.match("https://www.wikipedia.org/", "https://news.com/"));
    }

    @Test public void sanitizer() {
        assertEquals("passwd", FilenameSanitizer.sanitize("../../etc/passwd").name);
        FilenameSanitizer.Result r = FilenameSanitizer.sanitize("invoice‮fdp.exe");
        assertEquals("invoicefdp.exe", r.name);
        assertTrue(r.dangerous);
        assertEquals("_CON.txt", FilenameSanitizer.sanitize("CON.txt").name);
        assertEquals("download", FilenameSanitizer.sanitize("").name);
        assertTrue(FilenameSanitizer.sanitize("invoice.pdf.apk").disguised);
        assertFalse(FilenameSanitizer.sanitize("archive.tar.gz").dangerous);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 400; i++) sb.append('a');
        String longName = FilenameSanitizer.sanitize(sb + ".pdf").name;
        assertTrue(longName.length() <= 180 && longName.endsWith(".pdf"));
    }
}
