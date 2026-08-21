export function Card({ value, label, note }: { value: string; label: string; note?: string }) {
    return (
        <div className="card">
            <strong>{value}</strong>
            <span>{label}</span>
            {note ? <span className="muted">{note}</span> : null}
        </div>
    );
}
