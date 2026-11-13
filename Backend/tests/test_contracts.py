
import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource
from openapi_spec_validator import validate
from openapi_spec_validator.readers import read_from_filename


ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "packages" / "contracts"

with open(CONTRACTS / "analysis.schema.json") as f:
    analysis_schema = json.load(f)

with open(CONTRACTS / "journal.schema.json") as f:
    journal_schema = json.load(f)

registry = Registry().with_resource(
    "analysis.schema.json",
    Resource.from_contents(analysis_schema),
)

journal_validator = Draft202012Validator(
    journal_schema,
    registry=registry,
    format_checker=FormatChecker(),
)


def sample_journal():
    return {
        "id": "journal-001",
        "created_at": "2026-10-24T21:00:00Z",
        "status": "awaiting_upload",
        "video_url": None,
        "transcript": None,
        "analysis": None,
        "error_message": None,
    }


class TestContracts(unittest.TestCase):

    def test_schema_definitions(self):
        Draft202012Validator.check_schema(analysis_schema)
        Draft202012Validator.check_schema(journal_schema)

    def test_new_journal(self):
        journal_validator.validate(sample_journal())

    def test_completed_journal(self):
        journal = sample_journal()
        journal["status"] = "completed"
        journal["video_url"] = "/api/journals/journal-001/video"
        journal["transcript"] = "Today was a great day."
        journal["analysis"] = {
            "sentiment": "positive",
            "emotions": ["joy", "excitement"],
            "themes": ["school", "friends"],
            "summary": "The speaker describes a positive day.",
        }

        journal_validator.validate(journal)

    def test_invalid_analysis_rejected(self):
        journal = sample_journal()
        journal["status"] = "completed"
        journal["analysis"] = {
            "sentiment": "mixed",
            "emotions": ["joy"],
            "themes": ["school"],
            "summary": "An enjoyable day.",
        }

        with self.assertRaises(ValidationError):
            journal_validator.validate(journal)

    def test_openapi_contract(self):
        spec, base_uri = read_from_filename(
            str(CONTRACTS / "openapi.yaml")
        )
        validate(spec, base_uri=base_uri)


if __name__ == "__main__":
    unittest.main()
