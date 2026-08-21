export function KeyValues({ pairs }: { pairs: [string, string][] }) {
    return (
        <dl className="kv">
            {pairs.map(([label, value]) => (
                <div key={label} style={{ display: 'contents' }}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                </div>
            ))}
        </dl>
    );
}
