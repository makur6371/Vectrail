"""Vendored subset of the DTK protocol core (Apache-2.0).

Only the modules the Vectrail link importer needs are shipped; package
initialisers are trimmed so importing a submodule does not drag in the full
service stack (FastAPI, Redis, SQLAlchemy, ...).
"""
