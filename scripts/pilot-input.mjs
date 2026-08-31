const APPROVAL_NOT_RECEIVED = "PILOT_APPROVAL_NOT_RECEIVED";

export function createPilotInput({
  terminal,
  expectedDigest,
  onStop,
  onApprovalRejected,
  onStopError = () => {},
}) {
  let approved = false;
  let approvalSettled = false;
  let stopRequested = false;
  let resolveApproval;
  let rejectApproval;
  let stopPromise;

  const approval = new Promise((resolve, reject) => {
    resolveApproval = resolve;
    rejectApproval = reject;
  });

  const rejectApprovalIfPending = () => {
    if (approvalSettled) return;
    approvalSettled = true;
    rejectApproval(new Error(APPROVAL_NOT_RECEIVED));
  };

  const removeListeners = () => {
    terminal.off("line", onLine);
    terminal.off("close", onClose);
  };

  const stopOnce = () => {
    if (stopRequested) return stopPromise;
    stopRequested = true;
    rejectApprovalIfPending();
    removeListeners();

    let resolveStop;
    let rejectStop;
    stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    void stopPromise.catch(error => {
      try {
        void Promise.resolve(onStopError(error)).catch(() => undefined);
      } catch {
        // Stop callbacks must not create an unhandled rejection.
      }
    });

    try {
      Promise.resolve(onStop()).then(resolveStop, rejectStop);
    } catch (error) {
      rejectStop(error);
    }
    return stopPromise;
  };

  const onLine = line => {
    const trimmed = line.trim();
    if (trimmed === "stop") {
      void stopOnce();
      return;
    }
    if (approved) return;

    const submitted = /^approve ([a-f0-9]{64})$/.exec(trimmed)?.[1];
    if (submitted !== expectedDigest) {
      onApprovalRejected();
      return;
    }
    approved = true;
    approvalSettled = true;
    resolveApproval(submitted);
  };

  const onClose = () => {
    void stopOnce();
  };

  terminal.on("line", onLine);
  terminal.on("close", onClose);

  return { approval, stop: stopOnce };
}
