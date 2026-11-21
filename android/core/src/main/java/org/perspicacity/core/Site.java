package org.perspicacity.core;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** URL and site helpers. Mirrors desktop/src/main/site.js; keep the two in step. */
public final class Site {
    private Site() {}

    private static final Set<String> MULTI_LABEL_SUFFIXES = new HashSet<>(Arrays.asList(
            "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "nhs.uk",
            "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz", "govt.nz",
            "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr", "go.kr",
            "com.br", "net.br", "org.br", "gov.br", "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
            "com.hk", "org.hk", "com.tw", "org.tw", "com.sg", "edu.sg", "gov.sg", "com.my", "gov.my",
            "co.in", "net.in", "org.in", "gov.in", "ac.in", "co.za", "org.za", "gov.za",
            "com.mx", "gob.mx", "com.ar", "gob.ar", "com.tr", "gov.tr", "co.il", "org.il", "gov.il",
            "com.ua", "co.id", "or.id", "go.id", "com.vn", "gov.vn", "com.ph", "gov.ph", "com.pk",
            "com.ng", "gov.ng", "com.eg", "com.sa", "gov.sa", "com.co", "com.pe", "com.ve", "com.ec",
            "github.io", "gitlab.io", "blogspot.com", "herokuapp.com", "vercel.app", "netlify.app",
            "pages.dev", "workers.dev", "appspot.com", "cloudfront.net", "azurewebsites.net",
            "firebaseapp.com", "web.app", "onrender.com", "fly.dev", "glitch.me", "neocities.org"));

    private static final Pattern IPV4 = Pattern.compile("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$");
    private static final Pattern SCHEME = Pattern.compile("^[a-zA-Z][a-zA-Z0-9+.-]*://.*");
    private static final Pattern OPAQUE_SCHEME = Pattern.compile("^(?i)(about|javascript|data|file|blob|chrome|view-source|intent|content):.*");
    private static final Pattern HOSTLIKE = Pattern.compile("^[^/?#\\s]+\\.[a-zA-Z0-9-]{2,}(:\\d+)?([/?#].*)?$");
    private static final Pattern LOCALHOST = Pattern.compile("^(?i)localhost(:\\d+)?([/?#].*)?$");
    private static final Pattern IP_INPUT = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?([/?#].*)?$");

    public static String normaliseHost(String host) {
        if (host == null) return "";
        String h = host.toLowerCase(Locale.ROOT);
        if (h.endsWith(".")) h = h.substring(0, h.length() - 1);
        return h;
    }

    public static boolean isIpLiteral(String host) {
        return IPV4.matcher(host).matches() || host.contains(":");
    }

    /** eTLD+1 approximation. */
    public static String registrableDomain(String host) {
        String h = normaliseHost(host);
        if (h.isEmpty() || isIpLiteral(h)) return h;
        String[] parts = h.split("\\.");
        if (parts.length <= 2) return h;
        String last2 = parts[parts.length - 2] + "." + parts[parts.length - 1];
        if (MULTI_LABEL_SUFFIXES.contains(last2)) return parts[parts.length - 3] + "." + last2;
        return last2;
    }

    public static String hostOf(String url) {
        try {
            String h = new URI(url).getHost();
            return h == null ? "" : normaliseHost(h);
        } catch (Exception e) {
            return "";
        }
    }

    public static String siteOfUrl(String url) {
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return "";
        return registrableDomain(hostOf(url));
    }

    public static boolean isOnion(String host) {
        return normaliseHost(host).endsWith(".onion");
    }

    public static boolean isLoopback(String host) {
        String h = normaliseHost(host).replace("[", "").replace("]", "");
        if (h.equals("localhost") || h.endsWith(".localhost") || h.equals("::1")) return true;
        java.util.regex.Matcher m = IPV4.matcher(h);
        return m.matches() && m.group(1).equals("127");
    }

    /** HTTPS-Only mode: upgraded URL, or null when no upgrade applies. */
    public static String httpsUpgrade(String url) {
        if (url == null || !url.regionMatches(true, 0, "http://", 0, 7)) return null;
        String host = hostOf(url);
        if (host.isEmpty() || isOnion(host) || isLoopback(host)) return null;
        String rest = url.substring(7);
        int slash = rest.indexOf('/');
        String authority = slash < 0 ? rest : rest.substring(0, slash);
        String path = slash < 0 ? "/" : rest.substring(slash);
        if (authority.endsWith(":80")) authority = authority.substring(0, authority.length() - 3);
        return "https://" + authority + path;
    }

    public static boolean isNavigable(String url) {
        if (url == null) return false;
        if (url.equals("about:blank")) return true;
        String l = url.toLowerCase(Locale.ROOT);
        return (l.startsWith("http://") || l.startsWith("https://")) && !hostOf(url).isEmpty();
    }

    /** Omnibox input to URL; null for a refused scheme. searchTemplate contains "%s". */
    public static String omniboxToUrl(String input, String searchTemplate) {
        String text = input == null ? "" : input.trim();
        if (text.isEmpty()) return null;
        if (SCHEME.matcher(text).matches() || OPAQUE_SCHEME.matcher(text).matches()) {
            return isNavigable(text) ? text : null;
        }
        boolean hostLike = !text.contains(" ") && (HOSTLIKE.matcher(text).matches()
                || LOCALHOST.matcher(text).matches() || IP_INPUT.matcher(text).matches());
        if (hostLike) {
            String host = text.split("[/:?#]", 2)[0];
            String scheme = isOnion(host) || isLoopback(host) ? "http://" : "https://";
            String url = scheme + text;
            if (!hostOf(url).isEmpty()) {
                return url.indexOf('/', scheme.length()) < 0 && url.indexOf('?') < 0 && url.indexOf('#') < 0 ? url + "/" : url;
            }
        }
        try {
            return searchTemplate.replace("%s", URLEncoder.encode(text, StandardCharsets.UTF_8.name()).replace("+", "%20"));
        } catch (Exception e) {
            return null;
        }
    }
}
