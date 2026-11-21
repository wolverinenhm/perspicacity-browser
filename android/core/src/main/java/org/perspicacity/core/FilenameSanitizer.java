package org.perspicacity.core;

import java.text.Normalizer;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Download filename sanitiser. Mirrors desktop/src/main/sanitize.js. */
public final class FilenameSanitizer {
    private FilenameSanitizer() {}

    public static final Set<String> DANGEROUS = new HashSet<>(Arrays.asList(
            "exe", "msi", "msp", "bat", "cmd", "com", "scr", "pif", "cpl", "msc", "vbs", "vbe", "js", "jse",
            "wsf", "wsh", "ps1", "psm1", "psd1", "hta", "jar", "lnk", "url", "reg", "dll", "sys", "inf",
            "appx", "appxbundle", "msix", "msixbundle", "application", "gadget", "iso", "img", "vhd", "vhdx",
            "apk", "xapk", "app", "dmg", "pkg", "command", "sh", "run", "bin", "deb", "rpm", "appimage",
            "docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "xll", "chm", "settingcontent-ms"));
    private static final Pattern RESERVED = Pattern.compile("^(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(\\..*)?$");
    private static final Pattern INVISIBLE = Pattern.compile("[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]");
    private static final Pattern ILLEGAL = Pattern.compile("[\\u0000-\\u001f\\u007f<>:\"/\\\\|?*]");
    private static final int MAX = 180;

    public static final class Result {
        public final String name;
        public final boolean dangerous;
        public final boolean disguised;
        Result(String name, boolean dangerous, boolean disguised) {
            this.name = name; this.dangerous = dangerous; this.disguised = disguised;
        }
    }

    public static Result sanitize(String input) {
        String name = Normalizer.normalize(input == null ? "" : input, Normalizer.Form.NFC);
        String[] segs = name.split("[\\\\/]");
        name = segs.length == 0 ? "" : segs[segs.length - 1];
        name = INVISIBLE.matcher(name).replaceAll("");
        name = ILLEGAL.matcher(name).replaceAll("_");
        name = name.replaceAll("^[.\\s]+", "").replaceAll("[.\\s]+$", "").replaceAll("\\s+", " ");
        if (name.isEmpty()) name = "download";
        if (RESERVED.matcher(name).matches()) name = "_" + name;
        if (name.length() > MAX) {
            int dot = name.lastIndexOf('.');
            String ext = dot > 0 && name.length() - dot <= 16 ? name.substring(dot) : "";
            name = name.substring(0, MAX - ext.length()) + ext;
        }
        String[] parts = name.toLowerCase(Locale.ROOT).split("\\.");
        String ext = parts.length > 1 ? parts[parts.length - 1] : "";
        boolean dangerous = DANGEROUS.contains(ext);
        boolean disguised = dangerous && parts.length > 2 && parts[parts.length - 2].matches("[a-z0-9]{2,4}");
        return new Result(name, dangerous, disguised);
    }
}
