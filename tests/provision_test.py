import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('provision', Path(__file__).resolve().parents[1]/'scripts/provision-supabase.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeAPI:
    def __init__(self, plan='free'):
        self.plan=plan
        self.calls=[]
    def request(self,path,method='GET',body=None):
        self.calls.append((path,method,body))
        if path=='/organizations': return [{'name':'Woodline Free','id':'org','slug':'org'}]
        if path=='/organizations/org':return {'plan':self.plan}
        if path=='/projects' and method=='GET':return [{'name':'woodline-board','id':'project','organization_id':'org'}]
        if path=='/projects/project':return {'status':'ACTIVE_HEALTHY'}
        if path.endswith('/database/query'):
            return [{'board_rls':True,'history_rls':True,'anon_denied':True,'direct_write_denied':True}] if body['read_only'] else []
        if path.endswith('/config/auth'):
            return {'uri_allow_list':'https://existing.example.com/'} if method=='GET' else {}
        if path.endswith('/api-keys'):return [{'name':'service_role','api_key':'sb_secret_never_publish'},{'name':'anon','api_key':'sb_publishable_test','type':'publishable'}]
        raise AssertionError(path)

class ProvisionTests(unittest.TestCase):
    def test_paid_organization_cannot_create_or_modify_project(self):
        api=FakeAPI('pro')
        with self.assertRaisesRegex(RuntimeError,'not confirmed free'):module.provision(api,write_config=False)
        self.assertFalse(any(method!='GET' for _,method,_ in api.calls))
    def test_reuse_project_preserve_redirects_and_only_retrieve_public_config(self):
        api=FakeAPI()
        result=module.provision(api,write_config=False)
        self.assertTrue(result['schema_verified'])
        self.assertFalse(any(p=='/projects' and m=='POST' for p,m,_ in api.calls))
        patch=next(b for p,m,b in api.calls if p.endswith('/config/auth') and m=='PATCH')
        self.assertIn('https://existing.example.com/',patch['uri_allow_list'])
        self.assertIn(module.SITE,patch['uri_allow_list'])
        self.assertNotIn('mailer_autoconfirm',patch)

if __name__=='__main__':unittest.main()
