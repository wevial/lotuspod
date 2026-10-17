"""Pinned browser builds shared by widget script tags and their policy."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Library:
    package: str
    version: str
    file: str
    dependencies: tuple[str, ...]
    integrity: str

    @property
    def url(self) -> str:
        return f'https://cdn.jsdelivr.net/npm/{self.package}@{self.version}/{self.file}'


LIBRARIES = {
    'mermaid': Library('mermaid', '11.4.1', 'dist/mermaid.min.js', (),
        'sha384-rbtjAdnIQE/aQJGEgXrVUlMibdfTSa4PQju4HDhN3sR2PmaKFzhEafuePsl9H/9I'),
    'd3': Library('d3', '7.9.0', 'dist/d3.min.js', (),
        'sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i'),
    'plot': Library('@observablehq/plot', '0.6.17', 'dist/plot.umd.min.js', ('d3',),
        'sha384-JUpn2GgRr0gxU0xOBd8D8P634jhRCwobtG8G2MMEkX1RnGJ7/FJNnuukpfT+H2w1'),
    'chartjs': Library('chart.js', '4.4.8', 'dist/chart.umd.js', (),
        'sha384-sitkSLEO56SJYRloHWybrHos3JVvByQSlOZYJ1HiExytjxUlVOernDbpQcOgwtW8'),
}


def resolve(names: list[str]) -> list[Library]:
    """Expand dependencies once, preserving the requested order."""
    result = []
    seen = set()

    def visit(name):
        if name not in LIBRARIES:
            raise ValueError(f'unknown library {name}; allowed libraries: ' + ', '.join(LIBRARIES))
        if name in seen:
            return
        library = LIBRARIES[name]
        for dependency in library.dependencies:
            visit(dependency)
        seen.add(name)
        result.append(library)

    for name in names:
        visit(name)
    return result
