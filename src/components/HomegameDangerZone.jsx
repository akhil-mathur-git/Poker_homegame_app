import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/supabase.js";

export default function HomegameDangerZone({
  homegame,
  userId,
  run,
  busy,
  onMembershipChanged,
}) {
  const [confirming, setConfirming] = useState(false),
    [failure, setFailure] = useState("");
  const dialog = useRef(null);
  const owner = homegame.created_by === userId;
  useEffect(() => {
    if (confirming) dialog.current.showModal();
    else dialog.current.close();
  }, [confirming]);
  return (
    <section className="danger-zone">
      <h2>Homegame settings</h2>
      <p className="muted">
        {owner
          ? "You created this homegame. You can delete it, but cannot leave it."
          : "Leaving removes access for this device only. You can rejoin with the invite code."}
      </p>
      <button
        className="danger"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {owner ? "Delete homegame" : "Leave homegame"}
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="homegame-confirm-title"
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) setConfirming(false);
        }}
      >
        <h2 id="homegame-confirm-title">
          {owner ? "Delete" : "Leave"} “{homegame.name}”?
        </h2>
        <p>
          {owner
            ? "This permanently deletes this homegame’s players, active and completed games, history, settlements, memberships, and invite code. This cannot be undone."
            : "You will lose access on this account/device. The homegame and its history will remain for other members."}
        </p>
        <div className="actions">
          <button
            autoFocus
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setFailure("");
                try {
                  await rpc(owner ? "delete_homegame" : "leave_homegame", {
                    p_homegame: homegame.id,
                  });
                } catch (e) {
                  setFailure(e.message);
                  throw e;
                }
                setConfirming(false);
                await onMembershipChanged(homegame.id);
              })
            }
          >
            {owner ? "Yes, delete permanently" : "Yes, leave"}
          </button>
        </div>
        {failure && (
          <p className="negative" role="alert">
            {failure}
          </p>
        )}
        {busy && <p role="status">Updating homegame…</p>}
      </dialog>
    </section>
  );
}
