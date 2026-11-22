package org.perspicacity.core.agent;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

import org.perspicacity.core.Site;
import org.perspicacity.core.agent.AgentProtocol.Action;
import org.perspicacity.core.agent.AgentProtocol.ActionException;
import org.perspicacity.core.agent.AgentProtocol.Snapshot;

/**
 * One agent task (mirror of AgentRun in desktop/src/main/agent.js). Runs on a background
 * thread: observe the page, ask the model for one action, validate it, ask the user when the
 * action has an effect, perform it, repeat. Approvals, refusals and actions go to the audit.
 */
public final class AgentRun {
    public interface Driver {
        Snapshot snapshot() throws Exception;
        /** Performs a validated action; returns a short description of the result. */
        String perform(Action act, int gen) throws Exception;
        String currentUrl();
    }

    public interface Approver {
        boolean approve(String description, String action, String site) throws InterruptedException;
    }

    public interface Listener {
        void log(String kind, String text);
        void audit(String kind, String detail);
    }

    public static final class Result {
        public final String status;  // done | max-steps | error
        public final String message;
        Result(String status, String message) { this.status = status; this.message = message; }
    }

    private final String task;
    private final Driver driver;
    private final Providers.Decider decider;
    private final Approver approver;
    private final Listener listener;
    private final int maxSteps;
    private final long[] pacing;
    private final boolean autoApproveClicks;
    private final List<String> history = new ArrayList<>();
    private final Random random = new Random();
    private volatile boolean stopped;
    private volatile Thread thread;

    public AgentRun(String task, Driver driver, Providers.Decider decider, Approver approver, Listener listener,
                    int maxSteps, long[] pacing, boolean autoApproveClicks) {
        this.task = task.length() > 2000 ? task.substring(0, 2000) : task;
        this.driver = driver;
        this.decider = decider;
        this.approver = approver;
        this.listener = listener;
        this.maxSteps = maxSteps;
        this.pacing = pacing == null ? new long[] {400, 900} : pacing;
        this.autoApproveClicks = autoApproveClicks;
    }

    public void stop() {
        stopped = true;
        Thread t = thread;
        if (t != null) t.interrupt();
    }

    public boolean isStopped() { return stopped; }

    public Result run() {
        thread = Thread.currentThread();
        String startSite = Site.siteOfUrl(driver.currentUrl());
        listener.audit("agent.start", "site=" + startSite);
        listener.log("task", task);
        int invalid = 0;
        try {
            for (int step = 1; step <= maxSteps; step++) {
                if (stopped) throw new InterruptedException();
                Snapshot snap = driver.snapshot();
                listener.log("observe", "Step " + step + ": " + (snap.title.isEmpty() ? snap.url : snap.title) + " (" + snap.count + " elements)");
                String raw = decider.decide(AgentProtocol.buildUserMessage(task, snap, history));
                if (stopped) throw new InterruptedException();
                Action act;
                try {
                    act = AgentProtocol.validate(raw, snap);
                } catch (ActionException e) {
                    invalid++;
                    listener.log("reject", "Rejected model output: " + e.getMessage());
                    history.add("(invalid action rejected: " + e.getMessage() + ")");
                    if (invalid >= 3) throw new Exception("the model produced three invalid actions in a row");
                    continue;
                }
                invalid = 0;
                if (!act.thought.isEmpty()) listener.log("thought", act.thought);
                if (act.action.equals("done")) {
                    listener.audit("agent.done", act.answer.length() > 500 ? act.answer.substring(0, 500) : act.answer);
                    listener.log("done", act.answer.isEmpty() ? "Done." : act.answer);
                    return new Result("done", act.answer);
                }
                String need = AgentProtocol.approvalNeeded(act, snap.url, autoApproveClicks ? startSite : null);
                if (need != null) {
                    listener.log("approval", need);
                    String site = Site.siteOfUrl(snap.url);
                    boolean ok = approver.approve(need, act.action, site);
                    listener.audit(ok ? "agent.approved" : "agent.denied", (need.length() > 300 ? need.substring(0, 300) : need) + " site=" + site);
                    if (!ok) {
                        listener.log("denied", "You denied this action.");
                        history.add(act.action + " " + (act.id.isEmpty() ? act.url : act.id) + " was DENIED by the user; choose something else or finish.");
                        continue;
                    }
                }
                Thread.sleep(pacing[0] + (long) (random.nextDouble() * Math.max(0, pacing[1] - pacing[0])));
                String result = driver.perform(act, snap.gen);
                String target = !act.target.isEmpty() ? act.target : !act.url.isEmpty() ? act.url : act.direction;
                listener.audit("agent.action", act.action + " " + (target.length() > 200 ? target.substring(0, 200) : target) + " site=" + Site.siteOfUrl(snap.url));
                listener.log("act", result);
                history.add(act.action + (act.id.isEmpty() ? "" : " " + act.id) + (act.url.isEmpty() ? "" : " " + act.url) + ": " + result);
            }
            listener.log("done", "Stopped after " + maxSteps + " steps without finishing.");
            return new Result("max-steps", "");
        } catch (InterruptedException e) {
            listener.audit("agent.end", "Stopped.");
            listener.log("error", "Stopped.");
            return new Result("error", "Stopped.");
        } catch (Exception e) {
            String msg = stopped ? "Stopped." : "Error: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            listener.audit("agent.end", msg.length() > 200 ? msg.substring(0, 200) : msg);
            listener.log("error", msg);
            return new Result("error", msg);
        } finally {
            thread = null;
        }
    }
}
