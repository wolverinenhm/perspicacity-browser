package org.perspicacity.core;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Host-anchored network filter. Mirrors desktop/src/main/filter.js.
 * Thread-safe for concurrent {@link #match} calls once loading has finished.
 */
public final class FilterEngine {
    private static final Set<String> SUPPORTED_OPTIONS = new HashSet<>(Arrays.asList(
            "third-party", "3p", "important", "all", "document", "doc", "script", "image", "stylesheet",
            "xmlhttprequest", "xhr", "subdocument", "frame", "ping", "media", "font", "other", "websocket"));
    private static final Pattern HOST = Pattern.compile("^[a-z0-9-]+(\\.[a-z0-9-]+)+$");
    private static final Pattern HOSTS_FILE = Pattern.compile("^(?:0\\.0\\.0\\.0|127\\.0\\.0\\.1|::1?)\\s+(\\S+)");
    private static final Pattern COSMETIC = Pattern.compile("#[@?$%]?#");

    private static final class Rule {
        final String path;
        final boolean thirdParty;
        Rule(String path, boolean thirdParty) { this.path = path; this.thirdParty = thirdParty; }
    }

    private final Map<String, List<Rule>> block = new HashMap<>();
    private final Map<String, List<Rule>> allow = new HashMap<>();
    private int ruleCount;

    public int ruleCount() { return ruleCount; }

    public int addList(String text) {
        int n = 0;
        if (text == null) return 0;
        for (String line : text.split("\\r?\\n")) if (addRule(line)) n++;
        return n;
    }

    public boolean addRule(String raw) {
        String line = raw.trim();
        if (line.isEmpty() || line.startsWith("!") || line.startsWith("[") || line.startsWith("#")) return false;
        if (COSMETIC.matcher(line).find()) return false;
        Matcher hf = HOSTS_FILE.matcher(line);
        if (hf.find()) line = hf.group(1);
        boolean exception = false;
        if (line.startsWith("@@")) { exception = true; line = line.substring(2); }
        boolean thirdParty = false;
        int dollar = line.lastIndexOf('$');
        if (dollar > 0) {
            for (String o : line.substring(dollar + 1).split(",")) {
                String opt = o.trim().toLowerCase(Locale.ROOT);
                if (opt.isEmpty()) continue;
                if (opt.startsWith("~") || opt.startsWith("domain=") || !SUPPORTED_OPTIONS.contains(opt)) return false;
                if (opt.equals("third-party") || opt.equals("3p")) thirdParty = true;
            }
            line = line.substring(0, dollar);
        }
        String host;
        String path = "";
        if (line.startsWith("||")) {
            String body = line.substring(2).replaceAll("\\^\\|?$", "");
            int slash = body.indexOf('/');
            if (slash >= 0) {
                path = body.substring(slash).replaceAll("\\^.*$", "");
                body = body.substring(0, slash);
            }
            host = body.toLowerCase(Locale.ROOT);
        } else if (HOST.matcher(line.toLowerCase(Locale.ROOT)).matches()) {
            host = line.toLowerCase(Locale.ROOT);
        } else {
            return false;
        }
        if (!HOST.matcher(host).matches() || path.contains("*")) return false;
        Map<String, List<Rule>> map = exception ? allow : block;
        map.computeIfAbsent(host, k -> new ArrayList<>()).add(new Rule(path, thirdParty));
        ruleCount++;
        return true;
    }

    private static String lookup(Map<String, List<Rule>> map, String host, String path, boolean thirdParty) {
        String h = host;
        while (true) {
            List<Rule> rules = map.get(h);
            if (rules != null) {
                for (Rule r : rules) {
                    if (r.thirdParty && !thirdParty) continue;
                    if (!r.path.isEmpty() && !path.startsWith(r.path)) continue;
                    return "||" + h + r.path + "^";
                }
            }
            int dot = h.indexOf('.');
            if (dot < 0) return null;
            h = h.substring(dot + 1);
        }
    }

    /** @return the matching rule, or null when the request may proceed. */
    public String match(String url, String topUrl) {
        URI u;
        try { u = new URI(url); } catch (Exception e) { return null; }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (!(scheme.equals("http") || scheme.equals("https") || scheme.equals("ws") || scheme.equals("wss"))) return null;
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
        if (host.isEmpty()) return null;
        String path = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
        String topSite = topUrl == null ? "" : Site.siteOfUrl(topUrl);
        boolean thirdParty = !topSite.isEmpty() && !Site.registrableDomain(host).equals(topSite);
        if (lookup(allow, host, path, thirdParty) != null) return null;
        return lookup(block, host, path, thirdParty);
    }
}
